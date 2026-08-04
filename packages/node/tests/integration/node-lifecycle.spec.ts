import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type CoordinatorHandle, createCoordinator } from '@express-token-revoker/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorClient,
  type CoordinatorClientLike,
  createRevokerNode,
  type RevokerNode,
  type RevokerNodeConfig,
} from '../../src/index.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * Node lifecycle integration tests against a REAL coordinator (port 0 —
 * ephemeral binds, zero fixed ports). Covers:
 * - snapshot + tail bootstrap (exact state),
 * - live propagation,
 * - add() refusal (coordinator-only),
 * - health sync component,
 * - clean restart resumes from lastLsn WITHOUT a snapshot,
 * - corrupt sync state ⇒ rebootstrap via snapshot,
 * - geometry mismatch rejected at join.
 */

const COORDINATOR_ROTATE_TIME_MS = 3_600_000; // no auto-rotation inside a test

interface SnapshotSpy {
  getSnapshotCalls: number;
  wrap(real: CoordinatorClient): CoordinatorClientLike;
}

function makeSnapshotSpy(): SnapshotSpy {
  const spy: SnapshotSpy = {
    getSnapshotCalls: 0,
    wrap(real: CoordinatorClient): CoordinatorClientLike {
      return {
        getSnapshot: () => {
          spy.getSnapshotCalls++;
          return real.getSnapshot();
        },
        subscribe: (lastLsn) => real.subscribe(lastLsn),
        pollDeltas: (fromLsn, maxEvents) => real.pollDeltas(fromLsn, maxEvents),
        close: () => real.close(),
      };
    },
  };
  return spy;
}

describe('Node lifecycle (integration, real coordinator, port 0)', () => {
  const handles: CoordinatorHandle[] = [];
  const nodes: RevokerNode[] = [];
  const tempDirs: string[] = [];

  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etr-node-'));
    tempDirs.push(dir);
    return dir;
  };

  const startCoordinator = async (): Promise<CoordinatorHandle> => {
    const handle = await createCoordinator({
      id: 'coord-node-test',
      logger: createMockLogger(),
      port: 0,
      backupDir: makeDir(),
      opaqueHeader: 'Authorization',
      // Existing fast tests run the explicit dev-only mode (PD-1); the
      // distributed/auth.spec.ts suite covers the TLS modes with fixtures.
      auth: { mode: 'insecure' },
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: COORDINATOR_ROTATE_TIME_MS,
        backupRatioTime: 2,
      },
    });
    handles.push(handle);
    return handle;
  };

  const nodeConfig = (handle: CoordinatorHandle, backupDir: string): RevokerNodeConfig =>
    ({
      nodeId: 'node-a',
      coordinatorAddress: `127.0.0.1:${handle.port}`,
      logger: createMockLogger(),
      backupDir,
      opaqueHeader: 'Authorization',
      auth: { mode: 'insecure' },
      pollIntervalMs: 200,
      safetyFactor: 2,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: COORDINATOR_ROTATE_TIME_MS,
      },
    }) as RevokerNodeConfig;

  const startNode = async (
    handle: CoordinatorHandle,
    backupDir: string,
    spy?: SnapshotSpy
  ): Promise<RevokerNode> => {
    const node = await createRevokerNode(
      nodeConfig(handle, backupDir),
      spy ? { createClient: (options) => spy.wrap(new CoordinatorClient(options)) } : {}
    );
    nodes.push(node);
    return node;
  };

  const waitForStreaming = async (node: RevokerNode): Promise<void> => {
    // Connected AND fail-closed gate released (first post-drain keepalive
    // applied): healthy is the semantic "caught up and serving" signal.
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.healthy).toBe(true), {
      timeout: 8000,
    });
  };

  afterEach(async () => {
    for (const node of nodes.splice(0)) {
      try {
        await node.shutdown();
      } catch {
        // best effort
      }
    }
    for (const handle of handles.splice(0)) {
      try {
        await handle.shutdown();
      } catch {
        // best effort
      }
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bootstrap applies snapshot + tail exactly; live propagation works', async () => {
    const handle = await startCoordinator();
    const { coordinator } = handle;

    // Pre-snapshot entries, then a coordinated rotation so blobs exist.
    coordinator.add('pre-1');
    coordinator.add('pre-2');
    coordinator.add('pre-3');
    await coordinator.rotate();
    // Tail entries (after the snapshot consistency point).
    coordinator.add('tail-1');
    coordinator.add('tail-2');

    const node = await startNode(handle, makeDir());
    await waitForStreaming(node);

    // Snapshot entries (restored from the installed blobs) AND tail entries
    // (replayed from the backlog drain) are all revoked locally. The drain
    // is async after the stream opens — wait for the last tail entry.
    await vi.waitFor(() => expect(node.has('tail-2')).toBe(true), { timeout: 5000 });
    for (const item of ['pre-1', 'pre-2', 'pre-3', 'tail-1', 'tail-2']) {
      expect(node.has(item), `expected ${item} revoked`).toBe(true);
    }
    expect(node.has('never-revoked')).toBe(false);

    // Live propagation: a new revocation reaches the node through the stream.
    coordinator.add('live-1');
    await vi.waitFor(() => expect(node.has('live-1')).toBe(true), { timeout: 5000 });

    // add() is coordinator-only on a node (v1, PD-2 default).
    expect(() => node.add()).toThrow(/coordinator-only/);

    // Middleware passthrough from core.
    expect(typeof node.getMiddleware()).toBe('function');
  });

  it('healthCheck exposes the sync component', async () => {
    const handle = await startCoordinator();
    const node = await startNode(handle, makeDir());
    await waitForStreaming(node);

    const health = node.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.checks.sync).toMatchObject({
      healthy: true,
      connected: true,
      mode: 'streaming',
      dirty: false,
    });
    expect(typeof health.checks.sync.lastAppliedLsn).toBe('number');
    // Core components are present too.
    expect(health.checks.storage).toBeDefined();
    expect(health.checks.filter).toBeDefined();
    expect(health.checks.rotation).toBeDefined();
  });

  it('clean restart resumes from lastLsn WITHOUT a snapshot', async () => {
    const handle = await startCoordinator();
    const { coordinator } = handle;

    coordinator.add('a-1');
    coordinator.add('a-2');
    await coordinator.rotate();
    coordinator.add('a-3');

    const nodeDir = makeDir();
    const node1 = await startNode(handle, nodeDir);
    await waitForStreaming(node1);
    coordinator.add('a-4');
    await vi.waitFor(() => expect(node1.has('a-4')).toBe(true), { timeout: 5000 });
    await node1.shutdown();
    nodes.splice(nodes.indexOf(node1), 1);

    // Second node, same backupDir/nodeId, with a GetSnapshot spy.
    const spy = makeSnapshotSpy();
    const node2 = await startNode(handle, nodeDir, spy);
    await waitForStreaming(node2);

    expect(spy.getSnapshotCalls).toBe(0); // clean resume — no snapshot needed
    for (const item of ['a-1', 'a-2', 'a-3', 'a-4']) {
      expect(node2.has(item), `expected ${item} revoked after restart`).toBe(true);
    }

    // Replication still works after the resume.
    coordinator.add('a-5');
    await vi.waitFor(() => expect(node2.has('a-5')).toBe(true), { timeout: 5000 });
  });

  it('a corrupt sync state forces a rebootstrap via snapshot', async () => {
    const handle = await startCoordinator();
    const { coordinator } = handle;

    coordinator.add('b-1');
    await coordinator.rotate();
    coordinator.add('b-2');

    const nodeDir = makeDir();
    const node1 = await startNode(handle, nodeDir);
    await waitForStreaming(node1);
    await node1.shutdown();
    nodes.splice(nodes.indexOf(node1), 1);

    // Corrupt the persisted sync state — the node must treat it as absent.
    fs.writeFileSync(path.join(nodeDir, 'sync-state-node-a.json'), '{corrupt');

    const spy = makeSnapshotSpy();
    const node2 = await startNode(handle, nodeDir, spy);
    await waitForStreaming(node2);

    expect(spy.getSnapshotCalls).toBeGreaterThanOrEqual(1);
    // b-2 is tail (post-snapshot): wait for the backlog drain.
    await vi.waitFor(() => expect(node2.has('b-2')).toBe(true), { timeout: 5000 });
    expect(node2.has('b-1')).toBe(true);
    expect(node2.healthCheck().checks.sync.dirty).toBe(false);
  });

  it('rejects a snapshot whose geometry does not match the local config', async () => {
    const handle = await startCoordinator();
    const config = nodeConfig(handle, makeDir());
    // Local geometry differs from the coordinator's (numItems).
    (config as { filter: { numItems: number } }).filter = {
      ...config.filter,
      numItems: 5000,
    };

    await expect(createRevokerNode(config)).rejects.toThrow(/geometry mismatch/);
  });
});
