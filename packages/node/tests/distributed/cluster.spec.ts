import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorClient } from '../../src/index.js';
import { makeSnapshotSpy, StreamCorruptor, StreamGate, TestCluster } from '../helpers/cluster.js';

/**
 * Distributed cluster scenarios — THE PROOF.
 *
 * Real coordinator + real nodes over loopback gRPC (port 0 / ephemeral),
 * real timers, vi.waitFor only. Each scenario asserts the invariant it
 * protects — first and foremost: NO FALSE NEGATIVES, ever. A revoked token
 * must be rejected by every node; temporary false positives or degraded
 * availability are acceptable, under-revocation is not.
 */

const clusters: TestCluster[] = [];

function track(cluster: TestCluster): TestCluster {
  clusters.push(cluster);
  return cluster;
}

afterEach(async () => {
  for (const cluster of clusters.splice(0)) {
    await cluster.teardown();
  }
});

describe('Distributed cluster scenarios (integration, real coordinator + nodes)', () => {
  it('scenario 1 — propagation bound: a revocation reaches every node within the bound', async () => {
    const cluster = track(new TestCluster());
    const handle = await cluster.startCoordinator();
    const node1 = await cluster.startNode(handle);
    const node2 = await cluster.startNode(handle);
    await cluster.waitForStreaming(node1);
    await cluster.waitForStreaming(node2);

    // Push-latency assumption encoded by this bound: deltas are pushed over
    // a loopback gRPC stream through the coordinator's per-node single-writer
    // queue — propagation is normally well under 100 ms. The bound is a
    // generous CI ceiling; the waitFor timeout IS the assertion bound.
    const PROPAGATION_BOUND_MS = 2_000;
    // vi.waitFor polls (~50 ms granularity) — slack for the final poll only.
    const POLL_SLACK_MS = 250;

    const startedAt = Date.now();
    handle.coordinator.add('prop-token');
    await vi.waitFor(
      () => {
        expect(node1.has('prop-token')).toBe(true);
        expect(node2.has('prop-token')).toBe(true);
      },
      { timeout: PROPAGATION_BOUND_MS }
    );
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs, `propagation took ${elapsedMs} ms`).toBeLessThanOrEqual(
      PROPAGATION_BOUND_MS + POLL_SLACK_MS
    );
    // The coordinator's own filter agrees.
    expect(handle.coordinator.has('prop-token')).toBe(true);
  });

  it('scenario 2 — rotation frontier: a lagging node keeps coverage across the rotation boundary', async () => {
    const cluster = track(new TestCluster());
    // Huge rotateTime: rotations happen ONLY when the coordinator decides.
    const handle = await cluster.startCoordinator();
    const nodeFast = await cluster.startNode(handle);
    const gate = new StreamGate();
    const nodeLag = await cluster.startNode(handle, {
      createClient: (options) => gate.wrapClient(new CoordinatorClient(options)),
    });
    await cluster.waitForStreaming(nodeFast);
    await cluster.waitForStreaming(nodeLag);

    handle.coordinator.add('frontier-token');
    await vi.waitFor(
      () => {
        expect(nodeFast.has('frontier-token')).toBe(true);
        expect(nodeLag.has('frontier-token')).toBe(true);
      },
      { timeout: 5000 }
    );

    // Hold nodeLag's event queue, then keep revoking + rotate on the
    // coordinator while nodeLag is behind.
    gate.pause();
    handle.coordinator.add('frontier-late');
    await vi.waitFor(() => expect(nodeFast.has('frontier-late')).toBe(true), {
      timeout: 5000,
    });
    // Lag materialized: the entry sits in the gate, not in nodeLag's filter.
    expect(nodeLag.has('frontier-late')).toBe(false);
    expect(gate.bufferedCount).toBeGreaterThanOrEqual(1);

    await handle.coordinator.rotate();
    await vi.waitFor(
      () => expect(nodeFast.getMetrics().counters.rotations).toBeGreaterThanOrEqual(1),
      { timeout: 5000 }
    );

    // Release the backlog: nodeLag applies frontier-late and THEN the Rotate,
    // in canonical LSN order.
    gate.resume();
    await vi.waitFor(
      () => expect(nodeLag.getMetrics().counters.rotations).toBeGreaterThanOrEqual(1),
      { timeout: 5000 }
    );

    // THE INVARIANT: no false negative at the rotation frontier. Both tokens
    // were applied BEFORE the Rotate on nodeLag, so they landed in the
    // previous filter when the Rotate promoted current → previous.
    expect(nodeLag.has('frontier-token')).toBe(true);
    expect(nodeLag.has('frontier-late')).toBe(true);
    expect(nodeFast.has('frontier-token')).toBe(true);
    expect(nodeFast.has('frontier-late')).toBe(true);
    // nodeLag is fully caught up.
    expect(nodeLag.healthCheck().checks.sync.lastAppliedLsn).toBe(handle.coordinator.lastLsn);
  });

  it('scenario 3 — coordinator down: nodes keep serving revocations, then self-rotate dirty', async () => {
    const cluster = track(new TestCluster());
    const COORDINATOR_ROTATE_TIME_MS = 1_000;
    const handle = await cluster.startCoordinator({
      rotateTime: COORDINATOR_ROTATE_TIME_MS,
    });
    // safetyFactor 2 ⇒ node core rotateTime = 2 s: fast enough for the
    // degraded watchdog to fire inside the test, slow enough to assert the
    // token is still covered right after the first self-rotation (eviction
    // only happens at the SECOND self-rotation, 2 s later).
    const node = await cluster.startNode(handle, { safetyFactor: 2, pollIntervalMs: 200 });
    await cluster.waitForStreaming(node);

    handle.coordinator.add('down-token');
    await vi.waitFor(() => expect(node.has('down-token')).toBe(true), { timeout: 5000 });

    await handle.shutdown(); // coordinator down

    await vi.waitFor(() => expect(node.healthCheck().checks.sync.connected).toBe(false), {
      timeout: 8000,
    });
    expect(node.healthCheck().checks.sync.mode).toBe('poll');

    // INVARIANT: a degraded node keeps rejecting already-revoked tokens from
    // local state — revocation knowledge is never lost when the coordinator
    // dies.
    expect(node.has('down-token')).toBe(true);
    // Revocations are coordinator-only (v1): refused, never buffered locally.
    expect(() => node.add()).toThrow(/coordinator-only/);

    // After the safety window (rotateTime × safetyFactor = 2 s) without any
    // coordinated rotation, core's own timer self-rotates ⇒ dirty flag.
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.dirty).toBe(true), {
      timeout: 8000,
    });
    // Right after the first self-rotation the token moved to the previous
    // filter — still covered.
    expect(node.has('down-token')).toBe(true);
  });

  it('scenario 4a — reconnect catch-up: no missed entries, no double-apply', async () => {
    const cluster = track(new TestCluster());
    const id = 'coord-catchup';
    const backupDir = cluster.makeDir('etr-cluster-coord-');
    // Huge rotateTime: no rotation/eviction during the outage, so the
    // applied-counter arithmetic stays exact.
    const handle1 = await cluster.startCoordinator({ id, backupDir });
    const node = await cluster.startNode(handle1);
    await cluster.waitForStreaming(node);

    handle1.coordinator.add('r-1');
    await vi.waitFor(() => expect(node.has('r-1')).toBe(true), { timeout: 5000 });
    const appliedBefore = node.getMetrics().counters.applied;
    expect(appliedBefore).toBeGreaterThanOrEqual(1);

    await handle1.shutdown();
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.connected).toBe(false), {
      timeout: 8000,
    });

    // Restart on the SAME port with the SAME id + dirs: canonical LSNs
    // resume where they left off.
    const handle2 = await cluster.startCoordinator({ id, backupDir, port: handle1.port });
    handle2.coordinator.add('r-2');

    // The node reconnects (stream or degraded poll) and catches up from its
    // persisted lastLsn.
    await vi.waitFor(() => expect(node.has('r-2')).toBe(true), { timeout: 10000 });

    // Exactly ONE new apply: nothing missed, nothing double-applied
    // (at-least-once redelivery is skipped by the LSN check, not re-applied).
    expect(node.getMetrics().counters.applied).toBe(appliedBefore + 1);
    expect(node.healthCheck().checks.sync.lastAppliedLsn).toBe(handle2.coordinator.lastLsn);
    // The pre-outage revocation is still covered.
    expect(node.has('r-1')).toBe(true);
  });

  it('scenario 4b — dirty node rebootstraps from the snapshot on restart', async () => {
    const cluster = track(new TestCluster());
    const id = 'coord-dirty';
    const backupDir = cluster.makeDir('etr-cluster-coord-');
    const handle1 = await cluster.startCoordinator({ id, backupDir, rotateTime: 1_000 });
    const nodeDir = cluster.makeDir('etr-cluster-node-');
    const node1 = await cluster.startNode(handle1, {
      nodeId: 'node-dirty',
      backupDir: nodeDir,
      safetyFactor: 2,
    });
    await cluster.waitForStreaming(node1);

    handle1.coordinator.add('d-1');
    await vi.waitFor(() => expect(node1.has('d-1')).toBe(true), { timeout: 5000 });

    // Outage long enough for the degraded self-rotation watchdog to fire.
    await handle1.shutdown();
    await vi.waitFor(() => expect(node1.healthCheck().checks.sync.dirty).toBe(true), {
      timeout: 8000,
    });
    await node1.shutdown();

    // Coordinator comes back (same id/dirs/port) and keeps revoking.
    const handle2 = await cluster.startCoordinator({
      id,
      backupDir,
      port: handle1.port,
      rotateTime: 1_000,
    });
    handle2.coordinator.add('d-2');

    // Node restart: the persisted dirty flag must force a snapshot
    // rebootstrap instead of incremental catch-up.
    const spy = makeSnapshotSpy();
    const node2 = await cluster.startNode(handle2, {
      nodeId: 'node-dirty',
      backupDir: nodeDir,
      safetyFactor: 2,
      createClient: (options) => spy.wrap(new CoordinatorClient(options)),
    });
    await cluster.waitForStreaming(node2);

    expect(spy.getSnapshotCalls).toBeGreaterThanOrEqual(1); // dirty ⇒ snapshot path
    await vi.waitFor(
      () => {
        expect(node2.has('d-1')).toBe(true);
        expect(node2.has('d-2')).toBe(true);
      },
      { timeout: 5000 }
    );
    expect(node2.healthCheck().checks.sync.dirty).toBe(false);
  });

  it('scenario 5 — mid-stream join: snapshot + tail gives the joining node the exact state', async () => {
    const cluster = track(new TestCluster());
    const handle = await cluster.startCoordinator();
    const node1 = await cluster.startNode(handle);
    await cluster.waitForStreaming(node1);

    handle.coordinator.add('join-1');
    handle.coordinator.add('join-2');
    handle.coordinator.add('join-3');
    await vi.waitFor(() => expect(node1.has('join-3')).toBe(true), { timeout: 5000 });

    // Rotate so the snapshot has a consistency point with real blobs.
    await handle.coordinator.rotate();

    // Entries appended AFTER the snapshot consistency point (the tail).
    handle.coordinator.add('join-4');
    handle.coordinator.add('join-5');

    // A new node joins mid-stream: snapshot + tail replay ⇒ exact state.
    const node2 = await cluster.startNode(handle);
    await cluster.waitForStreaming(node2);
    await vi.waitFor(() => expect(node2.has('join-5')).toBe(true), { timeout: 5000 });

    for (const item of ['join-1', 'join-2', 'join-3', 'join-4', 'join-5']) {
      expect(node2.has(item), `expected ${item} revoked on the joining node`).toBe(true);
    }
    expect(node2.has('never-revoked')).toBe(false);
    expect(node2.healthCheck().checks.sync.lastAppliedLsn).toBe(handle.coordinator.lastLsn);
  });

  it('scenario 6 — injected LSN gap: the node rebootstraps instead of diverging silently', async () => {
    const cluster = track(new TestCluster());
    const handle = await cluster.startCoordinator();
    const spy = makeSnapshotSpy();
    const corruptor = new StreamCorruptor();
    const node = await cluster.startNode(handle, {
      createClient: (options) => spy.wrap(corruptor.wrapClient(new CoordinatorClient(options))),
    });
    await cluster.waitForStreaming(node);

    handle.coordinator.add('gap-1');
    await vi.waitFor(() => expect(node.has('gap-1')).toBe(true), { timeout: 5000 });
    // Fresh join bootstrapped once from the snapshot.
    const snapshotsBefore = spy.getSnapshotCalls;
    expect(snapshotsBefore).toBe(1);

    // Corrupt the next entry delivery: forge an LSN that skips the expected
    // one. The engine must treat this as unrecoverable — rebootstrap, never
    // guess, never drop silently.
    corruptor.arm();
    handle.coordinator.add('gap-2');

    await vi.waitFor(() => expect(spy.getSnapshotCalls).toBeGreaterThan(snapshotsBefore), {
      timeout: 10000,
    });
    // The node converges again: healthy stream, every revocation present.
    await cluster.waitForStreaming(node, 10000);
    await vi.waitFor(
      () => {
        expect(node.has('gap-1')).toBe(true);
        expect(node.has('gap-2')).toBe(true);
      },
      { timeout: 5000 }
    );
    expect(corruptor.injected).toBe(true);
    expect(node.healthCheck().healthy).toBe(true);
  });
});
