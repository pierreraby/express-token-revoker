import fs from 'node:fs';
import path from 'node:path';
import {
  createRevoker,
  InternalError,
  ValidationError,
  type Config as CoreRevokerConfig,
  type GenericLogger,
  type Metrics,
  type Revoker,
} from 'express-token-revoker';
import { CanonicalWal } from './canonicalWal.js';
import { Meta } from './meta.js';
import type { CanonicalEvent, MetaState, OutboundEvent } from './types.js';
import type { CoordinatorConfig } from './validation.js';

/** Maximum accepted length for a single revocation item (same as core). */
export const MAX_ITEM_LENGTH = 4096;

/** Upper bound for the startup replay of the canonical tail. */
const REPLAY_BATCH_LIMIT = 1_000_000;

/**
 * Consistent snapshot of the coordinator state, served to bootstrapping
 * nodes. Blobs are the raw bytes core writes to its .blob files
 * (Int32Array.buffer) — the node installs them and core's own restore path
 * does the geometry check, no new parsing code anywhere.
 */
export interface SnapshotData {
  currentBlob: Buffer;
  previousBlob: Buffer;
  generation: number;
  lastBackupLsn: number;
  numItems: number;
  fpRate: number;
  k: number;
  rotateTime: number;
}

/**
 * Result of an admin revocation through the coordinator.
 */
export interface AddResult {
  success: boolean;
  message: string;
  /** LSN assigned to the entry (also assigned when the local apply failed). */
  lsn: number;
}

/**
 * Listener for live replication events (wired by the gRPC server to fan out
 * to subscribed nodes).
 */
export type LiveEventListener = (event: OutboundEvent) => void;

/**
 * Validates a revocation item with the exact same rules as core add():
 * non-empty string, no line breaks / null characters (WAL poisoning), at
 * most 4096 characters.
 * @returns An error message, or null when valid.
 */
export function itemValidationError(item: unknown): string | null {
  if (typeof item !== 'string' || item.trim() === '') {
    return 'item must be a non-empty string';
  }
  if (item.length > MAX_ITEM_LENGTH) {
    return `item must not exceed ${MAX_ITEM_LENGTH} characters`;
  }
  if (/[\r\n\0]/.test(item)) {
    return 'item must not contain \\r, \\n or \\0 characters';
  }
  return null;
}

/**
 * The distributed revocation coordinator.
 *
 * Wraps a core Revoker (backup enabled, gRPC disabled — the coordinator is
 * the canonical writer and talks to nodes through the distributed service,
 * not core's admin service) and adds:
 *
 * - the canonical WAL: every event gets a monotonic LSN and is durable
 *   BEFORE the in-memory filter is updated (canonical-first ordering),
 * - coordinated rotation: core's onRotation hook appends a Rotate marker,
 *   advances the persisted generation and consistency point, applies
 *   retention, and broadcasts to nodes,
 * - crash recovery: meta + canonical WAL scan give monotonic LSN/generation
 *   resumption across restarts; the canonical tail is replayed idempotently
 *   into the restored filter,
 * - snapshots: core blob files + consistency point, for node bootstrap.
 *
 * Invariant: no delta is ever silently dropped. If the coordinator's local
 * apply fails (saturation), the LSN gets a tombstone in the canonical WAL
 * but the entry is still replicated to nodes — over-revocation is the safe
 * direction (never a false negative).
 */
export class Coordinator {
  readonly #config: CoordinatorConfig;
  readonly #logger: GenericLogger;
  readonly #walDir: string;
  #revoker: Revoker | null = null;
  #canonical: CanonicalWal | null = null;
  #meta: Meta | null = null;
  #metaState: MetaState = { generation: 0, lastLsn: 0, lastBackupLsn: 0 };
  #listener: LiveEventListener | null = null;
  /** LSN of the most recent coordinated rotation marker (0 = none yet). */
  #lastRotateLsn = 0;
  #ready = false;
  #shuttingDown = false;

  constructor(config: CoordinatorConfig) {
    this.#config = config;
    this.#logger = config.logger ?? console;
    this.#walDir = config.walDir ?? path.join(config.backupDir, 'canonical');
  }

  get id(): string {
    return this.#config.id;
  }

  get logger(): GenericLogger {
    return this.#logger;
  }

  /** The wrapped core revoker (exposed for tests and advanced tooling). */
  get revoker(): Revoker | null {
    return this.#revoker;
  }

  /** Current coordinated generation. */
  get generation(): number {
    return this.#metaState.generation;
  }

  /** Highest LSN assigned so far. */
  get lastLsn(): number {
    return this.#canonical ? this.#canonical.lastLsn : this.#metaState.lastLsn;
  }

  /** Consistency point of the last coordinated rotation. */
  get lastBackupLsn(): number {
    return this.#metaState.lastBackupLsn;
  }

  /**
   * Wires the live-event listener (the gRPC server's broadcast function).
   */
  setListener(listener: LiveEventListener | null): void {
    this.#listener = listener;
  }

  /**
   * Starts the coordinator: meta → canonical WAL discovery → core revoker
   * (restores its own blobs + WAL) → idempotent canonical tail replay.
   */
  async init(): Promise<void> {
    const metaPath = path.join(this.#walDir, `coordinator-meta-${this.#config.id}.json`);
    this.#meta = new Meta(metaPath);
    this.#metaState = this.#meta.read();

    this.#canonical = new CanonicalWal({
      dir: this.#walDir,
      revokerId: this.#config.id,
      logger: this.#logger,
    });

    // LSN / generation resumption: meta is checkpointed on rotations only,
    // so the WAL itself is consulted as the source of truth — a crash before
    // the next checkpoint must not rewind either counter.
    const scanned = this.#canonical.scan();
    const effectiveLastLsn = Math.max(this.#metaState.lastLsn, scanned.maxLsn);
    const effectiveGeneration = Math.max(this.#metaState.generation, scanned.maxGeneration);
    this.#canonical.init(effectiveLastLsn + 1, effectiveGeneration, this.#metaState.lastBackupLsn);

    await this.#createRevoker();

    this.#replayCanonicalTail();

    // Persist the derived state so the next restart starts from it.
    this.#metaState = {
      generation: effectiveGeneration,
      lastLsn: effectiveLastLsn,
      lastBackupLsn: this.#metaState.lastBackupLsn,
    };
    this.#meta.write(this.#metaState);
    this.#ready = true;
    this.#logger.info(
      `Coordinator "${this.#config.id}" ready (generation=${effectiveGeneration}, lastLsn=${effectiveLastLsn}, lastBackupLsn=${this.#metaState.lastBackupLsn})`
    );
  }

  /**
   * Creates the wrapped core revoker with backup enabled and the rotation
   * hook wired. Core restores its own blobs + WAL in the constructor.
   */
  async #createRevoker(): Promise<void> {
    const filterConfig = {
      numItems: this.#config.filter.numItems,
      fpRate: this.#config.filter.fpRate,
      rotateTime: this.#config.filter.rotateTime,
      backup: true,
      backupRatioTime: this.#config.filter.backupRatioTime,
      backupDir: this.#config.backupDir,
      bufferEnabled: false,
      onRotation: () => this.#onCoreRotation(),
    };

    const revokerConfig =
      'opaqueHeader' in this.#config && this.#config.opaqueHeader !== undefined
        ? {
            id: this.#config.id,
            logger: this.#logger,
            opaqueHeader: this.#config.opaqueHeader,
            filter: filterConfig,
          }
        : {
            id: this.#config.id,
            logger: this.#logger,
            claimsToCheck: (this.#config as { claimsToCheck: string[] }).claimsToCheck,
            payloadKey: (this.#config as { payloadKey: string }).payloadKey,
            filter: filterConfig,
          };

    try {
      this.#revoker = await createRevoker(revokerConfig as CoreRevokerConfig);
    } catch (error) {
      throw new InternalError(
        `Failed to initialize the coordinator's revoker: ${(error as Error).message}`
      );
    }
  }

  /**
   * Replays the canonical tail (entries with lsn > lastBackupLsn) into the
   * restored filter. Belt-and-braces over core's own restore, and the
   * recovery path when core's WAL was lost but the canonical WAL survived.
   *
   * - entries: applied via applyEntry() (idempotent — bloom bit-sets,
   *   WAL-before-memory preserved per entry),
   * - tombstones: skipped — the coordinator's local apply failed for those
   *   LSNs, its filter must converge to that exact state,
   * - rotation markers: skipped — core's own restore already reflects the
   *   rotations (blobs are written at rotation time); re-rotating here
   *   would double-rotate and evict still-covered tokens.
   */
  #replayCanonicalTail(): void {
    if (!this.#canonical || !this.#revoker) {
      throw new InternalError('Coordinator internals not initialized during replay');
    }
    const tail = this.#canonical.readSince(this.#metaState.lastBackupLsn, REPLAY_BATCH_LIMIT);
    let applied = 0;
    let skippedTombstones = 0;
    let skippedRotations = 0;
    for (const event of tail) {
      if (event.type === 'entry') {
        this.#revoker.applyEntry(event.item);
        applied += 1;
      } else if (event.type === 'tombstone') {
        skippedTombstones += 1;
      } else {
        skippedRotations += 1;
      }
    }
    if (tail.length > 0) {
      this.#logger.info(
        `Canonical tail replay: ${applied} entries applied, ` +
          `${skippedTombstones} tombstones and ${skippedRotations} rotation markers skipped ` +
          `(since lsn ${this.#metaState.lastBackupLsn})`
      );
    }
    if (tail.length >= REPLAY_BATCH_LIMIT) {
      this.#logger.warn(
        `Canonical tail replay hit the batch limit (${REPLAY_BATCH_LIMIT}) — ` +
          'the coordinator may be missing the newest entries; check the canonical WAL.'
      );
    }
  }

  /**
   * Core rotation observer: core has already rotated (blobs written, filters
   * promoted) when this fires. The coordinator makes that rotation canonical:
   * new generation → Rotate marker (LSN) → meta checkpoint (the marker LSN
   * becomes the snapshot consistency point) → retention → broadcast.
   *
   * Runs synchronously on purpose: core's hook is sync, and every step here
   * is a small synchronous write.
   */
  #onCoreRotation(): void {
    if (!this.#ready || !this.#canonical || !this.#meta) {
      // Cannot happen in practice (hook only fires after init completed and
      // before shutdown), but a rotation must never crash the process.
      this.#logger.error('Rotation hook fired while coordinator is not ready — ignored');
      return;
    }
    if (this.#shuttingDown) {
      return;
    }

    const newGeneration = this.#metaState.generation + 1;
    const rotateLsn = this.#canonical.appendRotate(newGeneration);

    // Every entry with lsn <= rotateLsn was added before this rotation and
    // is reflected in the blobs core just wrote — the new consistency point.
    this.#metaState = {
      generation: newGeneration,
      lastLsn: this.#canonical.lastLsn,
      lastBackupLsn: rotateLsn,
    };
    this.#meta.write(this.#metaState);

    const deleted = this.#canonical.truncateOldGenerations(newGeneration - 1, rotateLsn);
    if (deleted.length > 0) {
      this.#logger.debug(`Canonical retention deleted: ${deleted.join(', ')}`);
    }

    this.#logger.info(`Coordinated rotation: generation=${newGeneration}, lsn=${rotateLsn}`);
    this.#lastRotateLsn = rotateLsn;
    this.#listener?.({ kind: 'rotate', lsn: rotateLsn, generation: newGeneration });
  }

  /**
   * Revokes a token — canonical-first:
   * validate → append to canonical WAL (LSN assigned) → apply to the local
   * filter → broadcast to nodes.
   *
   * If the local apply fails (e.g. critical saturation), a tombstone is
   * recorded at the entry's LSN and the admin call fails — but the entry is
   * still broadcast: LSN continuity is preserved and nodes over-revoke
   * rather than under-revoke (no false negatives, ever).
   *
   * @throws {ValidationError} If the item is invalid.
   * @throws {InternalError} If the coordinator is shutting down or the
   * canonical append fails.
   */
  add(item: string): AddResult {
    if (this.#shuttingDown) {
      throw new InternalError('Cannot add token: coordinator is shutting down.');
    }
    if (!this.#revoker || !this.#canonical) {
      throw new InternalError('Coordinator is not initialized');
    }

    const invalid = itemValidationError(item);
    if (invalid) {
      throw new ValidationError(invalid);
    }

    const lsn = this.#canonical.appendEntry(item);
    const generation = this.#canonical.generation;

    let localApplyError: Error | null = null;
    try {
      this.#revoker.add(item);
    } catch (error) {
      localApplyError = error as Error;
      this.#canonical.appendTombstone(lsn, item);
      this.#logger.error(
        `Local apply failed for lsn ${lsn} — tombstoned and still replicated: ${localApplyError.message}`
      );
    }

    // Never silently drop: the entry reaches subscribers in both outcomes.
    this.#listener?.({ kind: 'entry', lsn, generation, item });

    if (localApplyError) {
      return {
        success: false,
        message:
          `Revocation replicated (lsn ${lsn}) but the coordinator's local apply failed: ` +
          `${localApplyError.message}`,
        lsn,
      };
    }
    return { success: true, message: 'Item revoked', lsn };
  }

  /**
   * Checks revocation against the coordinator's own filter (admin/debug and
   * consistency checks — nodes never call this on the request path).
   */
  has(item: string): boolean {
    if (!this.#revoker) {
      throw new InternalError('Coordinator is not initialized');
    }
    return this.#revoker.has(item);
  }

  /**
   * Core metrics plus coordinator cluster state.
   */
  getMetrics(): Metrics & { generation: number; lastLsn: number } {
    if (!this.#revoker) {
      throw new InternalError('Coordinator is not initialized');
    }
    return {
      ...this.#revoker.getMetrics(),
      generation: this.#metaState.generation,
      lastLsn: this.lastLsn,
    };
  }

  /**
   * Builds the bootstrap snapshot: meta FIRST, then blobs.
   *
   * Reading the meta before the blobs guarantees the blobs reflect at least
   * the layout at lastBackupLsn (core writes/renames blobs before the
   * rotation hook checkpoints the meta). If a rotation lands between the
   * two reads, the blobs are newer than the consistency point and the node's
   * tail replay covers the difference — exact or conservative, never lossy.
   */
  getSnapshot(): SnapshotData {
    if (!this.#revoker) {
      throw new InternalError('Coordinator is not initialized');
    }
    const metaState = this.#metaState;

    const readBlob = (name: string): Buffer => {
      const blobPath = path.join(this.#config.backupDir, name);
      try {
        return fs.existsSync(blobPath) ? fs.readFileSync(blobPath) : Buffer.alloc(0);
      } catch (error) {
        throw new InternalError(`Failed to read snapshot blob ${name}: ${(error as Error).message}`);
      }
    };

    const manager = this.#revoker.bloomFilterManager;
    if (!manager || !manager.current) {
      throw new InternalError('Coordinator filter is not available for snapshot');
    }

    return {
      currentBlob: readBlob(`current-${this.#config.id}.blob`),
      previousBlob: readBlob(`previous-${this.#config.id}.blob`),
      generation: metaState.generation,
      lastBackupLsn: metaState.lastBackupLsn,
      numItems: this.#config.filter.numItems,
      fpRate: this.#config.filter.fpRate,
      k: manager.current.k,
      rotateTime: this.#config.filter.rotateTime,
    };
  }

  /**
   * Reads retained canonical events with lsn > fromLsn (PollDeltas and the
   * Subscribe backlog drain).
   */
  readSince(fromLsn: number, maxEvents: number): CanonicalEvent[] {
    if (!this.#canonical) {
      throw new InternalError('Coordinator is not initialized');
    }
    return this.#canonical.readSince(fromLsn, maxEvents);
  }

  /**
   * Whether a subscriber that last applied `fromLsn` can still be served
   * from retained files (false ⇒ ResnapshotRequired).
   */
  canServeFrom(fromLsn: number): boolean {
    if (!this.#canonical) {
      throw new InternalError('Coordinator is not initialized');
    }
    return this.#canonical.canServeFrom(fromLsn);
  }

  /**
   * Forces a coordinated rotation now (admin/tests). The rotation is
   * performed by core; the onRotation hook makes it canonical (marker +
   * meta + retention + broadcast).
   */
  async rotate(): Promise<{ generation: number; lsn: number }> {
    if (!this.#revoker) {
      throw new InternalError('Coordinator is not initialized');
    }
    await this.#revoker.rotateOnDemand();
    return { generation: this.#metaState.generation, lsn: this.#lastRotateLsn };
  }

  /**
   * Graceful shutdown: checkpoint meta, stop the gRPC-facing resources
   * (server-side), then shut down the wrapped revoker (fail-closed).
   */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    this.#shuttingDown = true;
    if (this.#canonical && this.#meta) {
      this.#metaState = {
        generation: this.#metaState.generation,
        lastLsn: this.#canonical.lastLsn,
        lastBackupLsn: this.#metaState.lastBackupLsn,
      };
      this.#meta.write(this.#metaState);
    }
    if (this.#revoker) {
      await this.#revoker.shutdown();
      this.#revoker = null;
    }
    this.#listener = null;
    this.#logger.info(`Coordinator "${this.#config.id}" shut down`);
  }
}
