import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { createCoordinator, type CoordinatorHandle } from '../../src/index.js';
import type { CoordinatorConfig } from '../../src/validation.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import {
  collectStreamEvents,
  collectUntilEnd,
  createTestCoordinatorClient,
  waitForStreamError,
  cancelStream,
  type CoordinatorTestClient,
} from '../helpers/coordinatorClient.js';

/**
 * Integration tests for the coordinator's distributed gRPC service.
 * Everything binds port 0 (ephemeral) — zero fixed ports, no collisions.
 */

const ROTATE_TIME_MS = 3_600_000; // auto-rotation must never fire inside a test

function baseConfig(backupDir: string, overrides: Partial<CoordinatorConfig> = {}): CoordinatorConfig {
  return {
    id: 'coord-test',
    logger: createMockLogger(),
    port: 0,
    backupDir,
    opaqueHeader: 'Authorization',
    filter: {
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: ROTATE_TIME_MS,
      backupRatioTime: 2,
    },
    ...overrides,
  } as CoordinatorConfig;
}

describe('Coordinator distributed service (integration, port 0)', () => {
  const handles: CoordinatorHandle[] = [];
  const clients: CoordinatorTestClient[] = [];
  const tempDirs: string[] = [];

  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etr-coord-'));
    tempDirs.push(dir);
    return dir;
  };

  const start = async (
    overrides: Partial<CoordinatorConfig> = {}
  ): Promise<{ handle: CoordinatorHandle; client: CoordinatorTestClient }> => {
    const handle = await createCoordinator(baseConfig(makeDir(), overrides));
    handles.push(handle);
    const client = createTestCoordinatorClient(`127.0.0.1:${handle.port}`);
    clients.push(client);
    return { handle, client };
  };

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.close();
      } catch {
        // best effort
      }
    }
    for (const handle of handles.splice(0)) {
      await handle.shutdown();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid config before binding', async () => {
    await expect(
      createCoordinator(baseConfig(makeDir(), { port: -1 }) as CoordinatorConfig)
    ).rejects.toThrow(/Invalid coordinator config/);
  });

  it('refuses a non-loopback bind without allowInsecure', async () => {
    await expect(
      createCoordinator(baseConfig(makeDir(), { host: '192.168.1.10' }) as CoordinatorConfig)
    ).rejects.toThrow(/non-loopback/);
  });

  it('streams admin Adds to a subscribed node in LSN order', async () => {
    const { client } = await start({ keepaliveIntervalMs: 150 });

    const stream = client.subscribe({ nodeId: 'node-a', lastLsn: '0' });
    // The backlog drain task is enqueued synchronously on Subscribe; a short
    // settle keeps the test independent of drain-vs-live interleaving.
    const addResults = [];
    for (const item of ['tok-1', 'tok-2', 'tok-3']) {
      addResults.push(await client.add({ nodeId: 'admin', item }));
    }

    const events = await collectStreamEvents(stream, 3);
    expect(events.map((e) => e.event)).toEqual(['entry', 'entry', 'entry']);
    expect(events.map((e) => e.entry?.item)).toEqual(['tok-1', 'tok-2', 'tok-3']);
    expect(events.map((e) => Number(e.entry?.lsn))).toEqual([1, 2, 3]);
    // LSNs in the stream match the LSNs returned by the admin RPC.
    expect(addResults.map((r) => Number(r.lsn))).toEqual([1, 2, 3]);

    // Keepalives flow on the open stream (zombie detection).
    const withKeepalive = await collectStreamEvents(stream, 1);
    expect(withKeepalive[0].event).toBe('keepalive');

    // The node shows up in ListNodes with delivery progress.
    const list = await client.listNodes();
    expect(list.nodes).toHaveLength(1);
    expect(list.nodes[0]).toMatchObject({ nodeId: 'node-a', connected: true, lastLsn: '3' });

    // Coordinator Has() reflects the local apply.
    expect((await client.has({ item: 'tok-1' })).exists).toBe(true);
    expect((await client.has({ item: 'never-revoked' })).exists).toBe(false);

    cancelStream(stream);
  });

  it('rejects a second active Subscribe for the same nodeId (ALREADY_EXISTS)', async () => {
    const { client } = await start();
    const first = client.subscribe({ nodeId: 'node-a', lastLsn: '0' });
    // Wait until the first stream is registered.
    await vi.waitFor(async () => {
      const list = await client.listNodes();
      expect(list.nodes).toHaveLength(1);
    });

    const second = client.subscribe({ nodeId: 'node-a', lastLsn: '0' });
    await waitForStreamError(second, grpc.status.ALREADY_EXISTS);
    cancelStream(first);
  });

  it('broadcasts Rotate after preceding entries, and later entries carry the new generation', async () => {
    const { handle, client } = await start();

    const stream = client.subscribe({ nodeId: 'node-a', lastLsn: '0' });
    await client.add({ item: 'pre-rot-1' });
    await client.add({ item: 'pre-rot-2' });

    const rotated = await handle.coordinator.rotate();
    expect(rotated.generation).toBe(1);
    expect(Number.isInteger(rotated.lsn)).toBe(true);

    await client.add({ item: 'post-rot-1' });

    const events = await collectStreamEvents(stream, 4);
    expect(events.map((e) => e.event)).toEqual(['entry', 'entry', 'rotate', 'entry']);
    expect(events[0].entry?.item).toBe('pre-rot-1');
    expect(events[1].entry?.item).toBe('pre-rot-2');
    expect(Number(events[2].rotate?.lsn)).toBe(rotated.lsn);
    expect(events[2].rotate?.generation).toBe(1);
    expect(events[3].entry?.item).toBe('post-rot-1');
    expect(events[3].entry?.generation).toBe(1);
    // Ordering invariant: the rotation marker's LSN sits between the groups.
    expect(Number(events[2].rotate?.lsn)).toBe(Number(events[1].entry?.lsn) + 1);
    expect(Number(events[3].entry?.lsn)).toBe(Number(events[2].rotate?.lsn) + 1);

    cancelStream(stream);
  });

  it('serves a snapshot whose tail-replay reconstructs the exact state for a fresh subscriber', async () => {
    const { handle, client } = await start();

    await client.add({ item: 'snap-1' });
    await client.add({ item: 'snap-2' });

    // Before any backup/rotation: empty blobs, consistency point 0 — the
    // node reconstructs from the tail only (documented fallback).
    const earlySnapshot = await client.getSnapshot({ nodeId: 'node-b' });
    expect(earlySnapshot.currentBlob.length).toBe(0);
    expect(earlySnapshot.previousBlob.length).toBe(0);
    expect(earlySnapshot.lastBackupLsn).toBe('0');
    expect(earlySnapshot.generation).toBe(0);
    expect(earlySnapshot.numItems).toBe(1000);
    expect(earlySnapshot.fpRate).toBeCloseTo(0.0001);
    expect(earlySnapshot.k).toBeGreaterThan(0);
    expect(earlySnapshot.rotateTime).toBe(ROTATE_TIME_MS);

    // Tail-replay from the consistency point reconstructs the state.
    const earlyTail = await client.subscribe({ nodeId: 'node-b', lastLsn: earlySnapshot.lastBackupLsn });
    let events = await collectStreamEvents(earlyTail, 2);
    expect(events.map((e) => e.entry?.item)).toEqual(['snap-1', 'snap-2']);
    cancelStream(earlyTail);

    // After a rotation the blobs exist and the consistency point advances.
    await handle.coordinator.rotate();
    await client.add({ item: 'snap-3' });

    const snapshot = await client.getSnapshot({ nodeId: 'node-c' });
    // After rotation, core renamed current→previous: the rotated filter is
    // persisted as previousBlob; the fresh current filter is not backed up
    // until the next periodic backup, so currentBlob is empty here and the
    // node reconstructs it via tail replay from the consistency point.
    expect(snapshot.previousBlob.length).toBeGreaterThan(0);
    expect(snapshot.generation).toBe(1);
    const consistencyPoint = Number(snapshot.lastBackupLsn);
    expect(consistencyPoint).toBeGreaterThan(0);

    // Subscribing from the consistency point replays exactly the tail.
    const tail = client.subscribe({ nodeId: 'node-c', lastLsn: snapshot.lastBackupLsn });
    events = await collectStreamEvents(tail, 1);
    expect(events[0].entry?.item).toBe('snap-3');
    expect(Number(events[0].entry?.lsn)).toBe(consistencyPoint + 1);
    cancelStream(tail);
  });

  it('tombstones a saturated local apply without breaking LSN continuity', async () => {
    // numItems=10 ⇒ core blocks add() after 10*10=100 insertions:
    // 101 successful adds, then local applies fail.
    const { handle, client } = await start({
      filter: { numItems: 10, fpRate: 0.01, rotateTime: ROTATE_TIME_MS, backupRatioTime: 2 },
    });

    for (let i = 1; i <= 101; i++) {
      const result = handle.coordinator.add(`sat-${i}`);
      expect(result.success).toBe(true);
      expect(result.lsn).toBe(i);
    }

    // Local apply now fails (saturation) — but the entry is still
    // replicated and the LSN sequence stays contiguous.
    const failed1 = handle.coordinator.add('sat-102');
    expect(failed1.success).toBe(false);
    expect(failed1.lsn).toBe(102);
    const failed2 = handle.coordinator.add('sat-103');
    expect(failed2.success).toBe(false);
    expect(failed2.lsn).toBe(103);

    // No false negatives: the last successfully applied item is detected.
    expect(handle.coordinator.has('sat-101')).toBe(true);

    // The tombstones are recorded in the canonical WAL. (has() cannot prove
    // the local filter lacks a tombstoned item here: at 10× saturation the
    // Bloom FPR is ~100%, so has() false-positives on almost anything.)
    const tombstoned = handle.coordinator.readSince(101, 5);
    expect(tombstoned[0]).toMatchObject({ type: 'tombstone', lsn: 102, item: 'sat-102' });
    expect(tombstoned[1]).toMatchObject({ type: 'tombstone', lsn: 103, item: 'sat-103' });

    // Nodes still receive them: over-revocation is the safe direction.
    const poll = await client.pollDeltas({ nodeId: 'node-a', fromLsn: 100, maxEvents: 10 });
    expect(poll.events.map((e) => Number(e.entry?.lsn))).toEqual([101, 102, 103]);
    expect(poll.events.map((e) => e.entry?.item)).toEqual(['sat-101', 'sat-102', 'sat-103']);
    expect(poll.moreAvailable).toBe(false);

    // Same over the Subscribe stream.
    const stream = client.subscribe({ nodeId: 'node-b', lastLsn: '100' });
    const streamed = await collectStreamEvents(stream, 3);
    expect(streamed.map((e) => e.entry?.item)).toEqual(['sat-101', 'sat-102', 'sat-103']);
    cancelStream(stream);

    // Add RPC reports the failure but still assigns the LSN.
    const rpcResult = await client.add({ item: 'sat-104' });
    expect(rpcResult.success).toBe(false);
    expect(Number(rpcResult.lsn)).toBe(104);
  });

  it('rejects invalid items with INVALID_ARGUMENT (and never logs them raw)', async () => {
    const logger = createMockLogger();
    const { client } = await start({ logger } as Partial<CoordinatorConfig>);

    await expect(client.add({ item: '' })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    await expect(client.add({ item: 'bad\nitem' })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    await expect(client.add({ item: 'x'.repeat(4097) })).rejects.toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });

    // The logger never saw a raw item.
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls].flat().join(' ');
    expect(logged).not.toContain('bad\nitem');
  });

  it('restart resumes LSN numbering and serves catch-up from the consistency point', async () => {
    const dir = makeDir();
    let rotateLsn = 0;

    // --- First life: add, rotate, add, shut down. ---
    {
      const handle = await createCoordinator(baseConfig(dir));
      const client = createTestCoordinatorClient(`127.0.0.1:${handle.port}`);
      await client.add({ item: 'life1-a' });
      await client.add({ item: 'life1-b' });
      const rotated = await handle.coordinator.rotate();
      rotateLsn = rotated.lsn;
      await client.add({ item: 'life2-a' });
      await client.add({ item: 'life2-b' });
      expect(handle.coordinator.lastLsn).toBe(rotateLsn + 2);
      client.close();
      await handle.shutdown();
    }

    // --- Second life: same backupDir ⇒ restore + canonical replay. ---
    const handle = await createCoordinator(baseConfig(dir));
    handles.push(handle);
    const client = createTestCoordinatorClient(`127.0.0.1:${handle.port}`);
    clients.push(client);

    // Generation and LSN numbering resume — no rewind.
    expect(handle.coordinator.generation).toBe(1);
    expect(handle.coordinator.lastLsn).toBe(rotateLsn + 2);

    // Pre- and post-rotation revocations are both detected (restored state).
    expect(handle.coordinator.has('life1-a')).toBe(true);
    expect(handle.coordinator.has('life1-b')).toBe(true);
    expect(handle.coordinator.has('life2-a')).toBe(true);
    expect(handle.coordinator.has('life2-b')).toBe(true);

    // New revocations continue the LSN sequence.
    const next = handle.coordinator.add('life3-a');
    expect(next.lsn).toBe(rotateLsn + 3);

    // A node catching up from the consistency point gets the post-rotation
    // tail (and the new entry), in order.
    const tail = client.subscribe({ nodeId: 'node-a', lastLsn: String(rotateLsn) });
    const events = await collectStreamEvents(tail, 3);
    expect(events.map((e) => e.entry?.item)).toEqual(['life2-a', 'life2-b', 'life3-a']);
    expect(events.map((e) => Number(e.entry?.lsn))).toEqual([
      rotateLsn + 1,
      rotateLsn + 2,
      rotateLsn + 3,
    ]);
    cancelStream(tail);

    // A node resuming below the consistency point must resnapshot —
    // never silently diverge.
    const low = client.subscribe({ nodeId: 'node-b', lastLsn: '0' });
    const resnapshotEvents = await collectUntilEnd(low);
    expect(resnapshotEvents).toHaveLength(1);
    expect(resnapshotEvents[0].event).toBe('resnapshot');
    expect(resnapshotEvents[0].resnapshot?.generation).toBe(1);
  });
});
