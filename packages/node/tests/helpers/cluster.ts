import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoordinatorAuthConfig } from '@express-token-revoker/server';
import {
  type CoordinatorConfig,
  type CoordinatorHandle,
  createCoordinator,
} from '@express-token-revoker/server';
import { expect, vi } from 'vitest';
import {
  type CoordinatorClientLike,
  type CoordinatorClientOptions,
  createRevokerNode,
  type RevokerNode,
  type RevokerNodeConfig,
  type SyncSubscription,
  type WireStreamEvent,
} from '../../src/index.js';
import type { NodeAuthConfig } from '../../src/validation.js';
import { createMockLogger } from './mock-logger.js';

/**
 * Cluster test harness for the distributed integration scenarios
 * (tests/distributed/cluster.spec.ts).
 *
 * Everything is real: real coordinator + real nodes over loopback gRPC,
 * ephemeral ports (port 0) unless a scenario restarts a coordinator on an
 * explicit port, temp dirs cleaned up by teardown. No fixed ports, no
 * assertion-timing sleeps (vi.waitFor only).
 */

/** rotateTime large enough that no automatic rotation fires inside a test. */
export const NO_AUTO_ROTATION_MS = 3_600_000;

/** Default filter geometry shared by coordinators and nodes. */
const DEFAULT_NUM_ITEMS = 1_000;
const DEFAULT_FP_RATE = 0.0001;
const DEFAULT_BACKUP_RATIO_TIME = 2;

/** Bounded retry when re-binding an explicitly released port (restarts). */
const MAX_BIND_ATTEMPTS = 5;
const BIND_RETRY_DELAY_MS = 150;

/** Infrastructure-only delay (bind retries) — never used for assertion timing. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Options for starting a coordinator inside the cluster. */
export interface ClusterCoordinatorOptions {
  /**
   * Coordinator / revoker id. Pass the SAME id when restarting on the same
   * dirs — canonical WAL, meta and blob file names all embed it.
   */
  id?: string;
  /** gRPC port (0 = ephemeral). Pass the previous port when restarting. */
  port?: number;
  /** Backup dir (canonical WAL lives under it). Defaults to a fresh temp dir. */
  backupDir?: string;
  /** Coordinator rotateTime. Default: NO_AUTO_ROTATION_MS (manual rotations only). */
  rotateTime?: number;
  backupRatioTime?: number;
  keepaliveIntervalMs?: number;
  numItems?: number;
  fpRate?: number;
  /**
   * gRPC auth (PD-1). Default: explicit `{ mode: 'insecure' }` to keep the
   * cluster scenarios fast; the auth spec passes TLS fixtures instead.
   */
  auth?: CoordinatorAuthConfig;
}

/** Options for starting a node inside the cluster. */
export interface ClusterNodeOptions {
  nodeId?: string;
  /** Defaults to a fresh temp dir (pass an existing one to restart a node). */
  backupDir?: string;
  safetyFactor?: number;
  pollIntervalMs?: number;
  /** gRPC auth (PD-1). Defaults to the explicit insecure dev mode. */
  auth?: NodeAuthConfig;
  /** DI wrapper factory — stream gate / corruptor / snapshot spy. */
  createClient?: (options: CoordinatorClientOptions) => CoordinatorClientLike;
}

interface CoordinatorGeometry {
  rotateTime: number;
  numItems: number;
  fpRate: number;
}

/**
 * In-process cluster: one coordinator + N nodes, with tracked temp dirs and
 * a resilient teardown (nodes first, then coordinators, then dirs).
 */
export class TestCluster {
  #handles: CoordinatorHandle[] = [];
  #nodes: RevokerNode[] = [];
  #tempDirs: string[] = [];
  #geometryByHandle = new Map<CoordinatorHandle, CoordinatorGeometry>();
  #coordinatorSeq = 0;
  #nodeSeq = 0;

  /** Creates and tracks a temp dir (removed by teardown). */
  makeDir(prefix = 'etr-cluster-'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    this.#tempDirs.push(dir);
    return dir;
  }

  /** Starts a coordinator (port 0 unless an explicit port is given). */
  async startCoordinator(options: ClusterCoordinatorOptions = {}): Promise<CoordinatorHandle> {
    const rotateTime = options.rotateTime ?? NO_AUTO_ROTATION_MS;
    const numItems = options.numItems ?? DEFAULT_NUM_ITEMS;
    const fpRate = options.fpRate ?? DEFAULT_FP_RATE;
    const config: CoordinatorConfig = {
      id: options.id ?? `coord-${++this.#coordinatorSeq}`,
      logger: createMockLogger(),
      port: options.port ?? 0,
      backupDir: options.backupDir ?? this.makeDir('etr-cluster-coord-'),
      keepaliveIntervalMs: options.keepaliveIntervalMs ?? 5_000,
      opaqueHeader: 'Authorization',
      auth: options.auth ?? { mode: 'insecure' },
      filter: {
        numItems,
        fpRate,
        rotateTime,
        backupRatioTime: options.backupRatioTime ?? DEFAULT_BACKUP_RATIO_TIME,
      },
    };
    const handle = await this.#startWithBindRetry(config);
    this.#handles.push(handle);
    this.#geometryByHandle.set(handle, { rotateTime, numItems, fpRate });
    return handle;
  }

  /**
   * Starts a node against a coordinator. Filter geometry mirrors the
   * coordinator's (snapshot join rejects mismatches).
   */
  async startNode(
    handle: CoordinatorHandle,
    options: ClusterNodeOptions = {}
  ): Promise<RevokerNode> {
    const geometry = this.#geometryByHandle.get(handle);
    // TLS targets use the hostname form: grpc-js sets the TLS SNI servername
    // from the authority and Node forbids an IP literal there (SAN fixtures
    // cover DNS:localhost). Insecure mode keeps the numeric loopback.
    const secure = options.auth !== undefined && options.auth.mode !== 'insecure';
    const config = {
      nodeId: options.nodeId ?? `node-${++this.#nodeSeq}`,
      coordinatorAddress: `${secure ? 'localhost' : '127.0.0.1'}:${handle.port}`,
      logger: createMockLogger(),
      backupDir: options.backupDir ?? this.makeDir('etr-cluster-node-'),
      opaqueHeader: 'Authorization',
      auth: options.auth ?? { mode: 'insecure' },
      pollIntervalMs: options.pollIntervalMs ?? 200,
      safetyFactor: options.safetyFactor ?? 2,
      filter: {
        numItems: geometry?.numItems ?? DEFAULT_NUM_ITEMS,
        fpRate: geometry?.fpRate ?? DEFAULT_FP_RATE,
        rotateTime: geometry?.rotateTime ?? NO_AUTO_ROTATION_MS,
      },
    } as RevokerNodeConfig;
    const node = await createRevokerNode(
      config,
      options.createClient ? { createClient: options.createClient } : {}
    );
    this.#nodes.push(node);
    return node;
  }

  /** Waits until the node's primary replication stream is open. */
  async waitForStreaming(node: RevokerNode, timeoutMs = 8000): Promise<void> {
    await vi.waitFor(() => expect(node.healthCheck().checks.sync.connected).toBe(true), {
      timeout: timeoutMs,
    });
  }

  /** Stops nodes, then coordinators, then removes temp dirs. Idempotent. */
  async teardown(): Promise<void> {
    for (const node of this.#nodes.splice(0)) {
      try {
        await node.shutdown();
      } catch {
        // Best effort — teardown must never fail a test.
      }
    }
    for (const handle of this.#handles.splice(0)) {
      try {
        await handle.shutdown();
      } catch {
        // Best effort.
      }
    }
    for (const dir of this.#tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Explicit-port starts (restart scenarios) re-bind a just-released port;
   * retry the bind a bounded number of times. Ephemeral ports never collide.
   */
  async #startWithBindRetry(config: CoordinatorConfig): Promise<CoordinatorHandle> {
    if (config.port === 0) {
      return createCoordinator(config);
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt++) {
      try {
        return await createCoordinator(config);
      } catch (error) {
        lastError = error as Error;
        await delay(BIND_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }
}

/**
 * Interception seam shared by StreamGate and StreamCorruptor: wraps a real
 * Subscribe stream. Real `data` events go through the interceptor; the
 * engine's data listener is captured and fed by the interceptor. `error`
 * and `end` pass straight through to the real stream.
 */
class InterceptedSubscription implements SyncSubscription {
  readonly #real: SyncSubscription;
  readonly #onDataListener: (listener: (event: WireStreamEvent) => void) => void;

  constructor(
    real: SyncSubscription,
    onRealEvent: (event: WireStreamEvent) => void,
    onDataListener: (listener: (event: WireStreamEvent) => void) => void
  ) {
    this.#real = real;
    this.#onDataListener = onDataListener;
    real.on('data', onRealEvent);
  }

  on(event: 'data', listener: (event: WireStreamEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  on(
    event: 'data' | 'error' | 'end',
    listener: ((event: WireStreamEvent) => void) | ((error: Error) => void) | (() => void)
  ): this {
    if (event === 'data') {
      this.#onDataListener(listener as (event: WireStreamEvent) => void);
      return this;
    }
    if (event === 'error') {
      this.#real.on('error', listener as (error: Error) => void);
      return this;
    }
    this.#real.on('end', listener as () => void);
    return this;
  }

  cancel(): void {
    this.#real.cancel();
  }
}

/**
 * Holds a node's stream events while paused and releases them in arrival
 * order on resume — the scenario-2 tool for making a node lag across a
 * coordinated rotation.
 */
export class StreamGate {
  #paused = false;
  #buffered: WireStreamEvent[] = [];
  #dataListener: ((event: WireStreamEvent) => void) | null = null;

  get paused(): boolean {
    return this.#paused;
  }

  /** Number of events currently held (observable lag). */
  get bufferedCount(): number {
    return this.#buffered.length;
  }

  /** Hold every subsequent stream event (simulates a lagging consumer). */
  pause(): void {
    this.#paused = true;
  }

  /** Release the held events to the engine, in arrival order. */
  resume(): void {
    this.#paused = false;
    this.#drain();
  }

  /** Wraps a real client so every Subscribe stream passes through the gate. */
  wrapClient(real: CoordinatorClientLike): CoordinatorClientLike {
    return {
      getSnapshot: () => real.getSnapshot(),
      subscribe: async (lastLsn) =>
        new InterceptedSubscription(
          await real.subscribe(lastLsn),
          (event) => this.#handleRealEvent(event),
          (listener) => this.#registerDataListener(listener)
        ),
      pollDeltas: (fromLsn, maxEvents) => real.pollDeltas(fromLsn, maxEvents),
      close: () => real.close(),
    };
  }

  #handleRealEvent(event: WireStreamEvent): void {
    if (this.#paused) {
      this.#buffered.push(event);
      return;
    }
    this.#deliver(event);
  }

  #registerDataListener(listener: (event: WireStreamEvent) => void): void {
    this.#dataListener = listener;
    this.#drain();
  }

  #drain(): void {
    if (this.#paused || !this.#dataListener) {
      return;
    }
    const pending = this.#buffered.splice(0);
    for (const event of pending) {
      this.#deliver(event);
    }
  }

  #deliver(event: WireStreamEvent): void {
    if (this.#dataListener) {
      this.#dataListener(event);
    }
  }
}

/**
 * One-shot stream corruptor for scenario 6: when armed, the next entry
 * delivered on the stream is replaced by a forged entry whose LSN skips the
 * expected one (a gap). The engine must detect the gap and rebootstrap —
 * never serve a silently-diverged state.
 */
export class StreamCorruptor {
  #armed = false;
  #injected = false;
  #dataListener: ((event: WireStreamEvent) => void) | null = null;

  /** Inject a gap into the next entry delivered on the stream. */
  arm(): void {
    this.#armed = true;
  }

  /** True once the forged event has been delivered. */
  get injected(): boolean {
    return this.#injected;
  }

  /** Wraps a real client so every Subscribe stream passes through. */
  wrapClient(real: CoordinatorClientLike): CoordinatorClientLike {
    return {
      getSnapshot: () => real.getSnapshot(),
      subscribe: async (lastLsn) =>
        new InterceptedSubscription(
          await real.subscribe(lastLsn),
          (event) => this.#handleRealEvent(event),
          (listener) => {
            this.#dataListener = listener;
          }
        ),
      pollDeltas: (fromLsn, maxEvents) => real.pollDeltas(fromLsn, maxEvents),
      close: () => real.close(),
    };
  }

  #handleRealEvent(event: WireStreamEvent): void {
    if (this.#armed && event.event === 'entry' && event.entry) {
      this.#armed = false;
      this.#injected = true;
      // Forge an entry whose LSN skips the one the engine expects. The real
      // event is dropped: the gap must trigger a rebootstrap before anything
      // else applies (it is re-delivered by the post-rebootstrap backlog).
      const forgedLsn = Number(event.entry.lsn) + 1;
      this.#deliver({
        event: 'entry',
        entry: {
          lsn: String(forgedLsn),
          generation: event.entry.generation,
          item: 'cluster-test-gap-injection',
        },
      });
      return;
    }
    this.#deliver(event);
  }

  #deliver(event: WireStreamEvent): void {
    if (this.#dataListener) {
      this.#dataListener(event);
    }
  }
}

/** Counts GetSnapshot calls (bootstrap / rebootstrap observation). */
export interface SnapshotSpy {
  getSnapshotCalls: number;
  wrap(real: CoordinatorClientLike): CoordinatorClientLike;
}

export function makeSnapshotSpy(): SnapshotSpy {
  const spy: SnapshotSpy = {
    getSnapshotCalls: 0,
    wrap(real: CoordinatorClientLike): CoordinatorClientLike {
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
