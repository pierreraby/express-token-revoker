import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinatorClient, type CoordinatorClientLike } from '../../src/index.js';
import {
  makeSnapshotSpy,
  probeMiddleware,
  StalledStream,
  StreamCorruptor,
  StreamGate,
  TestCluster,
} from '../helpers/cluster.js';
import { createMockLogger } from '../helpers/mock-logger.js';

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

  it('scenario 7 — stalled-but-open stream: missed keepalives ⇒ degraded ⇒ dirty self-rotation ⇒ rebootstrap, never a silent accept', async () => {
    const cluster = track(new TestCluster());
    // Fast coordinator rotations + keepalives so the whole degraded path
    // runs inside the test window; the node mirrors the keepalive cadence.
    // rotateTime 1.5 s: a token survives >= 3 s (two rotations) — the
    // post-heal convergence assertions below run well inside that bound.
    const handle = await cluster.startCoordinator({
      rotateTime: 1_500,
      keepaliveIntervalMs: 200,
    });
    const logger = createMockLogger();
    // Holds the LIVE stream's events (including keepalives) once paused —
    // the stalled-but-open simulation. New calls are blocked separately.
    const gate = new StreamGate();
    let stalled = false;
    const node = await cluster.startNode(handle, {
      logger,
      safetyFactor: 2, // node core rotateTime = 3 s (self-rotation window)
      pollIntervalMs: 200,
      keepaliveIntervalMs: 200,
      createClient: (options) => {
        const real = new CoordinatorClient(options);
        const blocking: CoordinatorClientLike = {
          getSnapshot: () => (stalled ? Promise.reject(new Error('stalled')) : real.getSnapshot()),
          // Stalled-but-open: Subscribe succeeds, the stream never delivers.
          subscribe: (lastLsn) =>
            stalled ? Promise.resolve(new StalledStream()) : real.subscribe(lastLsn),
          pollDeltas: (fromLsn, maxEvents) =>
            stalled ? Promise.reject(new Error('stalled')) : real.pollDeltas(fromLsn, maxEvents),
          close: () => real.close(),
        };
        return gate.wrapClient(blocking);
      },
    });
    await cluster.waitForStreaming(node);
    const middleware = node.getMiddleware();

    handle.coordinator.add('stall-a');
    await vi.waitFor(
      () => expect(probeMiddleware(middleware, 'stall-a').outcome).toBe('rejected'),
      { timeout: 5000 }
    );

    // Stall the stream while the coordinator keeps living (rotating,
    // revoking): the open stream delivers nothing anymore and every new
    // call fails. The keepalive watchdog must detect the silence (3 missed
    // intervals) and degrade the node — a silent stream is never trusted.
    stalled = true;
    gate.pause();
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.connected).toBe(false), {
      timeout: 8000,
    });

    handle.coordinator.add('stall-b');

    // After the safety window (rotateTime × safetyFactor = 3 s) without any
    // coordinated Rotate reaching the node, core's own timer self-rotates ⇒
    // LOUD dirty flag + forced rebootstrap (which fails while stalled and
    // retries with backoff — dirty stays set the whole time).
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.dirty).toBe(true), {
      timeout: 10000,
    });
    const logged = logger.error.mock.calls.flat().join(' ');
    expect(logged).toMatch(/DEGRADED SELF-ROTATION/);

    // FAIL-CLOSED INVARIANT: degraded and self-rotated, the node STILL
    // rejects the pre-stall revocation — no silent acceptance window.
    expect(probeMiddleware(middleware, 'stall-a').outcome).toBe('rejected');
    expect(node.has('stall-a')).toBe(true);

    // Heal: revoke one more token right before healing — it is fresh at
    // convergence (added < 3 s before the rebootstrap installs, well inside
    // the two-rotation eviction bound), so the converged node MUST cover
    // it. Then the pending rebootstrap retry converges from the snapshot;
    // resume the gate so the held (idempotent, LSN-checked) events and the
    // new stream flow.
    handle.coordinator.add('stall-c');
    stalled = false;
    gate.resume();
    await cluster.waitForStreaming(node, 15000);
    await vi.waitFor(
      () => {
        expect(probeMiddleware(middleware, 'stall-c').outcome).toBe('rejected');
        expect(node.healthCheck().checks.sync.lastAppliedLsn).toBe(handle.coordinator.lastLsn);
      },
      { timeout: 10000 }
    );
    // Exact convergence on the stall tokens too — the coordinator is the
    // oracle: with a 1.5 s rotateTime they may have legitimately rotated
    // OUT of coverage during the outage (token TTL semantics); a node that
    // disagrees with the coordinator in EITHER direction has diverged.
    for (const item of ['stall-a', 'stall-b']) {
      expect(probeMiddleware(middleware, item).outcome).toBe(
        handle.coordinator.has(item) ? 'rejected' : 'accepted'
      );
    }
    expect(node.healthCheck().checks.sync.dirty).toBe(false);
    expect(node.healthCheck().healthy).toBe(true);
  });

  it('scenario 8 — the deployed middleware keeps rejecting across a hot rebootstrap (fail-closed swap)', async () => {
    const cluster = track(new TestCluster());
    const handle = await cluster.startCoordinator();
    const spy = makeSnapshotSpy();
    const corruptor = new StreamCorruptor();
    const node = await cluster.startNode(handle, {
      createClient: (options) => {
        const inner = spy.wrap(corruptor.wrapClient(new CoordinatorClient(options)));
        return {
          getSnapshot: async () => {
            // Widen every rebootstrap after the initial join a little so the
            // sampler below collects plenty of probes across the swap
            // (infrastructure-only delay — never used for assertion timing).
            if (spy.getSnapshotCalls >= 1) {
              await new Promise<void>((resolve) => setTimeout(resolve, 200));
            }
            return inner.getSnapshot();
          },
          subscribe: (lastLsn) => inner.subscribe(lastLsn),
          pollDeltas: (fromLsn, maxEvents) => inner.pollDeltas(fromLsn, maxEvents),
          close: () => inner.close(),
        };
      },
    });
    await cluster.waitForStreaming(node);

    // Captured ONCE, like a real Express app would: this exact handler
    // instance must survive the rebootstrap.
    const middleware = node.getMiddleware();

    handle.coordinator.add('mw-a');
    await vi.waitFor(() => expect(probeMiddleware(middleware, 'mw-a').outcome).toBe('rejected'), {
      timeout: 5000,
    });
    expect(probeMiddleware(middleware, 'mw-clean').outcome).toBe('accepted');
    const snapshotsBefore = spy.getSnapshotCalls;
    expect(snapshotsBefore).toBe(1);

    // Sample the middleware continuously across the rebootstrap. INVARIANT:
    // a revoked token is NEVER accepted — probes landing in the swap window
    // must throw (fail-closed 500), every other probe must reject.
    const outcomes: ReturnType<typeof probeMiddleware>[] = [];
    const sampler = setInterval(() => {
      outcomes.push(probeMiddleware(middleware, 'mw-a'));
    }, 5);

    corruptor.arm();
    handle.coordinator.add('mw-b'); // injected LSN gap ⇒ hot rebootstrap

    await vi.waitFor(() => expect(spy.getSnapshotCalls).toBeGreaterThan(snapshotsBefore), {
      timeout: 10000,
    });
    await cluster.waitForStreaming(node, 10000);
    await vi.waitFor(() => expect(node.has('mw-b')).toBe(true), { timeout: 5000 });
    clearInterval(sampler);

    // THE REGRESSION (C1): the pre-swap middleware instance still resolves
    // the CURRENT revoker after the swap — the old code closed over the
    // destroyed manager and silently accepted every revoked token.
    expect(probeMiddleware(middleware, 'mw-a').outcome).toBe('rejected');
    expect(probeMiddleware(middleware, 'mw-b').outcome).toBe('rejected');
    expect(probeMiddleware(middleware, 'mw-clean-2').outcome).toBe('accepted');

    expect(outcomes.length).toBeGreaterThan(0);
    for (const probe of outcomes) {
      expect(probe.outcome, 'a revoked token was accepted during the swap').not.toBe('accepted');
      if (probe.outcome === 'error') {
        expect((probe.error as Error).message).toMatch(/unavailable|not initialized/);
      }
    }

    // Deterministic fail-closed path: once the node shuts down, the SAME
    // deployed middleware throws instead of serving stale/destroyed state.
    const shutdownPromise = node.shutdown();
    expect(probeMiddleware(middleware, 'mw-a').outcome).toBe('error');
    await shutdownPromise;
  });
});
