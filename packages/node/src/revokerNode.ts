import fs from 'node:fs';
import path from 'node:path';
import {
  createRevoker,
  InternalError,
  ValidationError,
  type Config as CoreRevokerConfig,
  type GenericLogger,
  type HealthCheckComponent,
  type HealthStatus,
  type Metrics,
  type Revoker,
} from 'express-token-revoker';
import type { RequestHandler } from 'express';
import {
  CoordinatorClient,
  type CoordinatorClientOptions,
} from './coordinatorClient.js';
import { StateFile } from './stateFile.js';
import { SyncEngine, type SyncSubscription } from './syncEngine.js';
import type { SnapshotResponse } from './types.js';
import type { RevokerNodeConfig } from './validation.js';

/** Defaults (also documented in validation.ts). */
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SAFETY_FACTOR = 2.5;
const DEFAULT_BACKUP_RATIO_TIME = 2;
/** Rebootstrap retry backoff bounds (coordinator unreachable while resyncing). */
const REBOOTSTRAP_MIN_RETRY_MS = 1000;
const REBOOTSTRAP_MAX_RETRY_MS = 30_000;

/**
 * Minimal coordinator-client surface RevokerNode needs. CoordinatorClient
 * implements it; tests may inject a wrapper (see NodeDependencies).
 */
export interface CoordinatorClientLike {
  getSnapshot(): Promise<SnapshotResponse>;
  subscribe(lastLsn: number): Promise<SyncSubscription>;
  pollDeltas(
    fromLsn: number,
    maxEvents: number
  ): Promise<{ events: import('./types.js').WireStreamEvent[]; moreAvailable: boolean }>;
  close(): void;
}

/**
 * Dependency injection hooks — reserved for tests (mirrors core's
 * gRPCFunctions DI convention). Not for production use.
 */
export interface NodeDependencies {
  /** Replaces the coordinator client construction. */
  createClient?: (options: CoordinatorClientOptions) => CoordinatorClientLike;
}

/** Sync component of the node health check (plan §metrics/health). */
export interface SyncHealthComponent extends HealthCheckComponent {
  /** True while the primary replication stream is open. */
  connected: boolean;
  /** `bootstrap` | `streaming` | `poll` (degraded catch-up). */
  mode: 'bootstrap' | 'streaming' | 'poll';
  /** Highest replication LSN applied and persisted. */
  lastAppliedLsn: number;
  /** True after a degraded self-rotation (node re-bootstraps on reconnect). */
  dirty: boolean;
}

/** Node health: core components + the sync component. */
export interface NodeHealthStatus {
  healthy: boolean;
  checks: HealthStatus['checks'] & { sync: SyncHealthComponent };
}

/**
 * A distributed revocation participant node.
 *
 * Wraps a core Revoker (backup enabled, gRPC disabled) and replicates
 * revocation events from the coordinator through the ordered gRPC stream
 * (`distributed.proto`):
 *
 * - **Bootstrap**: `GetSnapshot` → geometry check → install blobs →
 *   `Subscribe(lastBackupLsn)` replays the canonical tail ⇒ exact state.
 * - **Clean restart**: persisted sync state + local blobs ⇒ local core
 *   restore + `Subscribe(lastLsn)` — no snapshot needed.
 * - **Degraded mode** (coordinator down): the node keeps serving checks
 *   from local state; the sync engine polls and reconnects with backoff.
 *   New revocations are refused — `add()` always throws (coordinator-only).
 * - **Degraded self-rotation**: core runs with
 *   `rotateTime = coordinatorRotateTime × safetyFactor`; a rotation with no
 *   coordinated event in that window means core's own timer fired ⇒ the
 *   node marks itself dirty and re-bootstraps on reconnect.
 * - **Never drop a delta**: LSN gaps, generation mismatches or
 *   `ResnapshotRequired` trigger a loud rebootstrap from the snapshot.
 *
 * Rebootstrap swap window: while re-bootstrapping, the local revoker is
 * destroyed before the replacement is constructed. Checks landing in that
 * short window throw (middleware ⇒ 500) — fail-closed, never under-revoke.
 */
export class RevokerNode {
  readonly #config: RevokerNodeConfig;
  readonly #logger: GenericLogger;
  readonly #backupDir: string;
  readonly #safetyFactor: number;
  readonly #pollIntervalMs: number;
  readonly #deps: NodeDependencies;
  #client: CoordinatorClientLike | null = null;
  #stateFile: StateFile | null = null;
  #revoker: Revoker | null = null;
  #engine: SyncEngine | null = null;
  #dirty = false;
  #bootstrapping = false;
  #rebootstrapTimer: NodeJS.Timeout | null = null;
  #shuttingDown = false;

  constructor(config: RevokerNodeConfig, deps: NodeDependencies = {}) {
    this.#config = config;
    this.#logger = config.logger ?? console;
    this.#backupDir = config.backupDir;
    this.#safetyFactor = config.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#deps = deps;
  }

  get nodeId(): string {
    return this.#config.nodeId;
  }

  /**
   * Starts the node: local resume when possible, snapshot bootstrap
   * otherwise, then the sync engine.
   */
  async init(): Promise<void> {
    fs.mkdirSync(this.#backupDir, { recursive: true });

    const clientOptions: CoordinatorClientOptions = {
      address: this.#config.coordinatorAddress,
      nodeId: this.#config.nodeId,
      logger: this.#logger,
      authMetadata: this.#config.authMetadata,
    };
    this.#client = this.#deps.createClient
      ? this.#deps.createClient(clientOptions)
      : new CoordinatorClient(clientOptions);
    this.#stateFile = new StateFile(this.#backupDir, this.#config.nodeId);

    const state = this.#stateFile.read();
    if (state && !state.dirty && this.#blobsPresent()) {
      // Clean restart: core restores blobs + local WAL (conservative —
      // extra false positives only), then catch up from the persisted LSN.
      this.#dirty = false;
      await this.#createRevoker(this.#config.filter.rotateTime);
      this.#startEngine(state.lastLsn, state.generation);
      this.#logger.info(
        `Node ${this.#config.nodeId} resumed from local state (lsn=${state.lastLsn}, generation=${state.generation})`
      );
      return;
    }

    if (state?.dirty) {
      this.#logger.warn(
        `Node ${this.#config.nodeId}: dirty sync state detected — re-bootstrapping from the coordinator snapshot`
      );
    }
    await this.#bootstrapFromSnapshot();
  }

  /** Express middleware from core — checks the LOCAL filter. */
  getMiddleware(): RequestHandler {
    if (!this.#revoker) {
      throw new InternalError('Node revoker is not initialized');
    }
    return this.#revoker.getMiddleware();
  }

  /** Local revocation check (never contacts the coordinator). */
  has(item: string): boolean {
    if (!this.#revoker) {
      throw new InternalError(
        'Node revoker is not initialized (possibly re-bootstrapping — retry shortly)'
      );
    }
    return this.#revoker.has(item);
  }

  /** Core metrics passthrough. */
  getMetrics(): Metrics {
    if (!this.#revoker) {
      throw new InternalError('Node revoker is not initialized');
    }
    return this.#revoker.getMetrics();
  }

  /**
   * Revocations are coordinator-only (v1, PD-2 default): buffering at the
   * node would need LSN reconciliation on reconnect — always refused with
   * a clear error.
   */
  add(): never {
    throw new InternalError('revocations are coordinator-only — call the coordinator');
  }

  /** Core health + the sync component. */
  healthCheck(): NodeHealthStatus {
    let coreChecks: HealthStatus['checks'];
    let coreHealthy: boolean;
    if (this.#revoker) {
      const core = this.#revoker.healthCheck();
      coreChecks = core.checks;
      coreHealthy = core.healthy;
    } else {
      const unavailable: HealthCheckComponent = {
        healthy: false,
        error: 'Node revoker is not initialized',
      };
      coreChecks = { storage: unavailable, filter: unavailable, rotation: unavailable };
      coreHealthy = false;
    }

    const mode = this.#syncMode();
    const connected = this.#engine?.connected ?? false;
    const lastAppliedLsn = this.#engine?.lastAppliedLsn ?? this.#stateFile?.read()?.lastLsn ?? 0;

    let syncError: string | undefined;
    if (!connected) {
      syncError = this.#bootstrapping
        ? 'Node is bootstrapping from the coordinator snapshot'
        : 'Replication stream is down — degraded poll/reconnect in progress';
    } else if (this.#dirty) {
      syncError = 'Node self-rotated while degraded (dirty) — rebootstrap pending';
    }

    const sync: SyncHealthComponent = {
      healthy: connected && !this.#dirty,
      error: syncError,
      connected,
      mode,
      lastAppliedLsn,
      dirty: this.#dirty,
    };

    return {
      healthy: coreHealthy && sync.healthy,
      checks: { ...coreChecks, sync },
    };
  }

  /** Graceful shutdown: sync engine → client → core revoker. */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    this.#shuttingDown = true;
    this.#clearRebootstrapTimer();
    if (this.#engine) {
      await this.#engine.stop();
      this.#engine = null;
    }
    this.#client?.close();
    if (this.#revoker) {
      await this.#revoker.shutdown();
    }
    this.#logger.info(`Node ${this.#config.nodeId} shut down`);
  }

  /** Shuts down and destroys local resources. */
  async destroy(): Promise<void> {
    if (!this.#shuttingDown) {
      await this.shutdown();
      return;
    }
    if (this.#revoker) {
      await this.#revoker.destroy();
      this.#revoker = null;
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  #syncMode(): SyncHealthComponent['mode'] {
    if (this.#bootstrapping) {
      return 'bootstrap';
    }
    if (this.#engine?.connected) {
      return 'streaming';
    }
    return 'poll';
  }

  #blobsPresent(): boolean {
    const id = this.#config.nodeId;
    return (
      fs.existsSync(path.join(this.#backupDir, `current-${id}.blob`)) ||
      fs.existsSync(path.join(this.#backupDir, `previous-${id}.blob`))
    );
  }

  /**
   * Snapshot bootstrap (initial join and rebootstrap):
   * GetSnapshot → geometry check → wipe local files → install blobs →
   * persist sync state → construct core (restore validates geometry) →
   * Subscribe(lastBackupLsn) replays the tail ⇒ exact state.
   */
  async #bootstrapFromSnapshot(): Promise<void> {
    if (!this.#client || !this.#stateFile) {
      throw new InternalError('Node internals not initialized during bootstrap');
    }
    this.#bootstrapping = true;
    try {
      const snapshot = await this.#client.getSnapshot();
      this.#validateSnapshotGeometry(snapshot);

      // Stop replication activity and the old revoker before touching files.
      if (this.#engine) {
        await this.#engine.stop();
        this.#engine = null;
      }
      if (this.#revoker) {
        await this.#revoker.destroy();
        this.#revoker = null;
      }

      this.#wipeBackupFiles();
      const lastBackupLsn = Number(snapshot.lastBackupLsn);
      if (snapshot.currentBlob && snapshot.currentBlob.length > 0) {
        this.#writeFileAtomic(
          path.join(this.#backupDir, `current-${this.#config.nodeId}.blob`),
          snapshot.currentBlob
        );
      }
      if (snapshot.previousBlob && snapshot.previousBlob.length > 0) {
        this.#writeFileAtomic(
          path.join(this.#backupDir, `previous-${this.#config.nodeId}.blob`),
          snapshot.previousBlob
        );
      }

      this.#dirty = false;
      this.#stateFile.write({
        lastLsn: lastBackupLsn,
        generation: snapshot.generation,
        dirty: false,
      });

      // The snapshot carries the coordinator's ACTUAL rotateTime — trust
      // it over the locally configured expectation for the safety window.
      await this.#createRevoker(snapshot.rotateTime);
      this.#startEngine(lastBackupLsn, snapshot.generation);
      this.#logger.info(
        `Node ${this.#config.nodeId} bootstrapped from snapshot ` +
          `(generation=${snapshot.generation}, lsn=${lastBackupLsn})`
      );
    } finally {
      this.#bootstrapping = false;
    }
  }

  /**
   * Rejects a snapshot whose geometry does not match the local config.
   * Identical (numItems, fpRate) deterministically yields identical
   * (m, k) in core's withTargetError — checking both is checking the
   * geometry; snapshot.k is a diagnostic.
   */
  #validateSnapshotGeometry(snapshot: SnapshotResponse): void {
    const { numItems, fpRate } = this.#config.filter;
    if (snapshot.numItems !== numItems || snapshot.fpRate !== fpRate) {
      throw new ValidationError(
        `Snapshot geometry mismatch — the coordinator filter (numItems=${snapshot.numItems}, ` +
          `fpRate=${snapshot.fpRate}, k=${snapshot.k}) does not match this node's config ` +
          `(numItems=${numItems}, fpRate=${fpRate}). Refusing to join: re-dimension the node ` +
          'or fix its config.'
      );
    }
  }

  /** Removes local blobs/WAL before installing a snapshot. */
  #wipeBackupFiles(): void {
    const id = this.#config.nodeId;
    for (const name of [`current-${id}.blob`, `previous-${id}.blob`, `temp-${id}.txt`]) {
      fs.rmSync(path.join(this.#backupDir, name), { force: true });
    }
  }

  #writeFileAtomic(filePath: string, data: Buffer | Uint8Array): void {
    const tmpPath = `${filePath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Constructs the wrapped core revoker.
   *
   * Core rotateTime = coordinator rotateTime × safetyFactor: while the
   * stream is healthy, coordinated rotations arrive every coordinator
   * rotateTime and reset this clock (rotateOnDemand restarts the
   * interval), so core never self-rotates. Only a sustained outage beyond
   * the safety window lets core's own timer fire — the degraded
   * self-rotation detected by #onCoreRotation.
   */
  async #createRevoker(coordinatorRotateTime: number): Promise<void> {
    const filterConfig = {
      numItems: this.#config.filter.numItems,
      fpRate: this.#config.filter.fpRate,
      rotateTime: Math.ceil(coordinatorRotateTime * this.#safetyFactor),
      backup: true,
      backupRatioTime: this.#config.filter.backupRatioTime ?? DEFAULT_BACKUP_RATIO_TIME,
      backupDir: this.#backupDir,
      bufferEnabled: false,
      onRotation: () => this.#onCoreRotation(),
    };

    const revokerConfig =
      'opaqueHeader' in this.#config && this.#config.opaqueHeader !== undefined
        ? {
            id: this.#config.nodeId,
            logger: this.#logger,
            opaqueHeader: this.#config.opaqueHeader,
            filter: filterConfig,
          }
        : {
            id: this.#config.nodeId,
            logger: this.#logger,
            claimsToCheck: (this.#config as { claimsToCheck: string[] }).claimsToCheck,
            payloadKey: (this.#config as { payloadKey: string }).payloadKey,
            filter: filterConfig,
          };

    try {
      this.#revoker = await createRevoker(revokerConfig as CoreRevokerConfig);
    } catch (error) {
      throw new InternalError(
        `Failed to initialize the node revoker: ${(error as Error).message}`
      );
    }
  }

  /**
   * Core rotation observer. Coordinated rotations (stream or poll) are
   * flagged by the engine; anything else while the engine exists is a
   * degraded SELF-rotation ⇒ mark dirty (rebootstrap on reconnect).
   */
  #onCoreRotation(): void {
    if (this.#shuttingDown) {
      return;
    }
    if (this.#engine?.isRotationExternallyDriven()) {
      return;
    }
    this.#logger.warn(
      `Node ${this.#config.nodeId}: degraded self-rotation detected — ` +
        'marking sync state dirty (rebootstrap on reconnect)'
    );
    this.#dirty = true;
    this.#stateFile?.update({ dirty: true });
  }

  #startEngine(lastLsn: number, generation: number): void {
    if (!this.#revoker || !this.#client || !this.#stateFile) {
      throw new InternalError('Node internals not initialized during engine start');
    }
    const revoker = this.#revoker;
    const client = this.#client;
    this.#engine = new SyncEngine({
      nodeId: this.#config.nodeId,
      revoker,
      client: {
        subscribe: (resumeLsn) => client.subscribe(resumeLsn),
        pollDeltas: (fromLsn, maxEvents) => client.pollDeltas(fromLsn, maxEvents),
      },
      stateStore: this.#stateFile,
      logger: this.#logger,
      initialLsn: lastLsn,
      initialGeneration: generation,
      pollIntervalMs: this.#pollIntervalMs,
      onRebootstrapRequired: (reason) => this.#onRebootstrapRequired(reason),
    });
    this.#engine.start();
  }

  /** The engine hit an unrecoverable anomaly — resync from the snapshot. */
  #onRebootstrapRequired(reason: string): void {
    if (this.#shuttingDown) {
      return;
    }
    this.#logger.error(
      `Node ${this.#config.nodeId}: ${reason} — scheduling a full rebootstrap`
    );
    this.#scheduleRebootstrap(0);
  }

  /** Rebootstrap with bounded retry backoff (coordinator may be flapping). */
  #scheduleRebootstrap(delayMs: number): void {
    this.#clearRebootstrapTimer();
    this.#rebootstrapTimer = setTimeout(async () => {
      if (this.#shuttingDown) {
        return;
      }
      try {
        await this.#bootstrapFromSnapshot();
      } catch (error) {
        const retryDelay = Math.min(
          Math.max(delayMs, REBOOTSTRAP_MIN_RETRY_MS) * 2,
          REBOOTSTRAP_MAX_RETRY_MS
        );
        this.#logger.error(
          `Node ${this.#config.nodeId}: rebootstrap failed: ${(error as Error).message} ` +
            `— retrying in ${retryDelay} ms`
        );
        this.#scheduleRebootstrap(retryDelay);
      }
    }, delayMs);
  }

  #clearRebootstrapTimer(): void {
    if (this.#rebootstrapTimer) {
      clearTimeout(this.#rebootstrapTimer);
      this.#rebootstrapTimer = null;
    }
  }
}
