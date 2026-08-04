import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import {
  type Config as CoreRevokerConfig,
  createRevoker,
  type GenericLogger,
  type HealthCheckComponent,
  type HealthStatus,
  InternalError,
  type Metrics,
  type Revoker,
  ValidationError,
} from 'express-token-revoker';
import { CoordinatorClient, type CoordinatorClientOptions } from './coordinatorClient.js';
import { StateFile } from './stateFile.js';
import { SyncEngine, type SyncSubscription } from './syncEngine.js';
import type { SnapshotResponse } from './types.js';
import type { RevokerNodeConfig } from './validation.js';

/** Defaults (also documented in validation.ts). */
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SAFETY_FACTOR = 2.5;
const DEFAULT_BACKUP_RATIO_TIME = 2;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 5000;
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
  /** True after a degraded self-rotation (immediate rebootstrap pending). */
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
 * - **Dirty restart**: a persisted dirty flag (degraded self-rotation,
 *   below) ⇒ full rebootstrap from the coordinator snapshot at init.
 * - **Degraded mode** (coordinator down): the node keeps serving checks
 *   from local state; the sync engine polls and reconnects with backoff.
 *   New revocations are refused — `add()` always throws (coordinator-only).
 * - **Degraded self-rotation**: core runs with
 *   `rotateTime = coordinatorRotateTime × safetyFactor`; a rotation with no
 *   coordinated Rotate event in that window means core's own timer fired
 *   (coordinator down OR stream stalled) ⇒ the node marks itself dirty
 *   (persisted, so a restart re-bootstraps too) and IMMEDIATELY schedules a
 *   snapshot rebootstrap — fail-closed: a self-rotation can diverge from
 *   the coordinator's rotation schedule, so the node never keeps serving
 *   incrementally on top of it.
 * - **Never drop a delta**: LSN gaps, generation mismatches or
 *   `ResnapshotRequired` trigger a loud rebootstrap from the snapshot.
 *
 * Rebootstrap swap window: while re-bootstrapping, the local revoker is
 * nulled BEFORE being destroyed and the replacement is only published once
 * constructed. `getMiddleware()` re-resolves the current revoker on every
 * request, so checks landing in that window throw (middleware ⇒ 500) —
 * fail-closed, never under-revoke. The same applies during shutdown and
 * during the post-bootstrap catch-up: after a snapshot (re)bootstrap the
 * tail since the consistency point has not been replayed yet, so checks
 * keep throwing until the first keepalive arrives on the new stream —
 * the coordinator serializes it AFTER the backlog drain on its
 * single-writer chain, so receiving it proves the node is fully caught up.
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
  /**
   * Fail-closed serving gate after a snapshot (re)bootstrap: true until the
   * first keepalive arrives on the new stream (the coordinator's post-drain
   * marker — proof the backlog has been fully replayed). While set, checks
   * throw instead of serving a filter that is missing the tail.
   */
  #catchingUp = false;
  #rebootstrapTimer: NodeJS.Timeout | null = null;
  /** True while a rebootstrap is queued or running (dedup guard). */
  #rebootstrapPending = false;
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
      auth: this.#config.auth,
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

  /**
   * Express middleware checking the LOCAL filter.
   *
   * Returns a wrapper that RE-RESOLVES the current revoker on every
   * request (never a closure over one manager instance): a hot rebootstrap
   * destroys the old revoker and installs a replacement, and a handler
   * captured before the swap must keep tracking the live revoker. During
   * the swap window (revoker nulled, replacement not yet constructed) and
   * during shutdown the wrapper THROWS — Express maps the synchronous throw
   * to a 500. Fail-closed: ambiguity never becomes an accept.
   */
  getMiddleware(): RequestHandler {
    if (!this.#revoker) {
      throw new InternalError('Node revoker is not initialized');
    }
    return (req, res, next) => {
      const revoker = this.#revoker;
      if (!revoker || this.#shuttingDown || this.#catchingUp) {
        throw new InternalError(
          'Node revoker is unavailable (shutting down, re-bootstrapping or catching up) — failing closed'
        );
      }
      revoker.getMiddleware()(req, res, next);
    };
  }

  /** Local revocation check (never contacts the coordinator). */
  has(item: string): boolean {
    if (!this.#revoker || this.#shuttingDown || this.#catchingUp) {
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
    this.#rebootstrapPending = false;
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

      // From this point the local state is being rebuilt: gate the serving
      // path fail-closed until the new stream proves full catch-up (the
      // coordinator's post-drain keepalive marker).
      this.#catchingUp = true;

      // Stop replication activity and the old revoker before touching
      // files. The revoker is nulled BEFORE destroy: every resolution path
      // (middleware wrapper, has()) must fail closed the instant the swap
      // starts — a destroyed manager's has() returns false (fail-open).
      if (this.#engine) {
        await this.#engine.stop();
        this.#engine = null;
      }
      if (this.#revoker) {
        const oldRevoker = this.#revoker;
        this.#revoker = null;
        await oldRevoker.destroy();
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
      throw new InternalError(`Failed to initialize the node revoker: ${(error as Error).message}`);
    }
  }

  /**
   * Core rotation observer. Coordinated rotations (stream or poll) are
   * flagged by the engine (`#inCoordinatedRotation`); anything else is a
   * degraded SELF-rotation — even while the engine believes it is
   * streaming, since a stalled-but-open stream delivers nothing. The node
   * marks itself dirty (persisted ⇒ a restart re-bootstraps too) and
   * immediately schedules a snapshot rebootstrap: continuing to serve on
   * top of a self-rotation risks diverging from the coordinator's rotation
   * schedule (double-rotation ⇒ evicted coverage) — fail-closed.
   */
  #onCoreRotation(): void {
    if (this.#shuttingDown) {
      return;
    }
    if (this.#engine?.isRotationExternallyDriven()) {
      return;
    }
    this.#logger.error(
      `Node ${this.#config.nodeId}: DEGRADED SELF-ROTATION detected — core's safety timer ` +
        'fired without a coordinated Rotate event (coordinator down or stalled stream). ' +
        'Marking sync state DIRTY and forcing a snapshot rebootstrap.'
    );
    this.#dirty = true;
    try {
      this.#stateFile?.update({ dirty: true });
    } catch (error) {
      // The live rebootstrap below still heals the node; persistence
      // failure only degrades the restart path — never stay silent.
      this.#logger.error(
        `Node ${this.#config.nodeId}: failed to persist the dirty flag: ${(error as Error).message}`
      );
    }
    this.#scheduleRebootstrap(0);
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
      keepaliveIntervalMs: this.#config.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
      onRebootstrapRequired: (reason) => this.#onRebootstrapRequired(reason),
      onKeepaliveReceived: () => {
        // The coordinator serializes the first keepalive AFTER the backlog
        // drain on the node's delivery chain — receiving it proves the tail
        // has been replayed: release the fail-closed serving gate.
        if (this.#catchingUp) {
          this.#catchingUp = false;
          this.#logger.info(`Node ${this.#config.nodeId}: backlog caught up — serving checks`);
        }
      },
    });
    this.#engine.start();
  }

  /** The engine hit an unrecoverable anomaly — resync from the snapshot. */
  #onRebootstrapRequired(reason: string): void {
    if (this.#shuttingDown) {
      return;
    }
    this.#logger.error(`Node ${this.#config.nodeId}: ${reason} — scheduling a full rebootstrap`);
    this.#scheduleRebootstrap(0);
  }

  /**
   * Rebootstrap with bounded retry backoff (coordinator may be flapping).
   * Deduplicated: at most one queued/in-flight rebootstrap at a time —
   * repeated anomalies (e.g. successive degraded self-rotations during a
   * long outage) must not stack concurrent bootstraps.
   */
  #scheduleRebootstrap(delayMs: number): void {
    if (this.#shuttingDown || this.#rebootstrapPending || this.#bootstrapping) {
      return; // already queued or running
    }
    this.#rebootstrapPending = true;
    this.#clearRebootstrapTimer();
    this.#rebootstrapTimer = setTimeout(async () => {
      if (this.#shuttingDown) {
        this.#rebootstrapPending = false;
        return;
      }
      try {
        await this.#bootstrapFromSnapshot();
        this.#rebootstrapPending = false;
      } catch (error) {
        this.#rebootstrapPending = false;
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
