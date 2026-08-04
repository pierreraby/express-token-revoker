import type { GenericLogger, WireStreamEvent } from './types.js';

/** Sync engine operating modes. */
export type SyncEngineMode = 'idle' | 'streaming' | 'reconnecting' | 'stopped';

/**
 * Minimal revoker surface the engine drives (structural, so tests can stub
 * it; production passes the core Revoker).
 */
export interface SyncEngineRevoker {
  applyEntry(item: string): void;
  rotateOnDemand(): Promise<void>;
}

/** Minimal stream surface (grpc-js ClientReadableStream satisfies this). */
export interface SyncSubscription {
  on(event: 'data', listener: (event: WireStreamEvent) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  cancel(): void;
}

/** Minimal coordinator-client surface the engine drives. */
export interface SyncEngineClient {
  subscribe(lastLsn: number): Promise<SyncSubscription>;
  pollDeltas(
    fromLsn: number,
    maxEvents: number
  ): Promise<{ events: WireStreamEvent[]; moreAvailable: boolean }>;
}

/** State persistence surface (StateFile satisfies this). */
export interface SyncStateStore {
  update(state: { lastLsn: number; generation: number; dirty?: boolean }): void;
}

/** Options for the sync engine. */
export interface SyncEngineOptions {
  nodeId: string;
  revoker: SyncEngineRevoker;
  client: SyncEngineClient;
  stateStore: SyncStateStore;
  logger: GenericLogger;
  /** Resume AFTER this LSN (bootstrap point or persisted lastLsn). */
  initialLsn: number;
  /** Generation matching initialLsn. */
  initialGeneration: number;
  /** Degraded-mode poll cadence. Defaults to 2000 ms. */
  pollIntervalMs?: number;
  /** Max events per PollDeltas page. Defaults to 1000. */
  maxPollEvents?: number;
  /** First reconnect delay. Defaults to 1000 ms. */
  baseReconnectDelayMs?: number;
  /** Reconnect delay cap. Defaults to 30000 ms. */
  maxReconnectDelayMs?: number;
  /**
   * Fired on any unrecoverable stream anomaly (LSN gap, generation
   * mismatch, ResnapshotRequired, unappliable entry). The owner must
   * rebootstrap from the coordinator snapshot. The engine stops all
   * activity after firing it.
   */
  onRebootstrapRequired?: (reason: string) => void;
  /** Test seam: replaces the reconnect backoff sleep. */
  delayFn?: (ms: number) => Promise<void>;
}

/** Hard cap on poll pagination within one poll tick. */
const MAX_POLL_PAGES = 100;

/** Jitter applied to reconnect delays (±20%). */
function withJitter(delayMs: number): number {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

/**
 * The node's replication state machine.
 *
 * Modes:
 * - `streaming`: live Subscribe stream open; events applied in arrival
 *   order (the coordinator delivers them in canonical LSN order).
 * - `reconnecting`: stream down. The engine both (a) retries Subscribe
 *   with exponential backoff 1s→30s (jitter) and (b) polls PollDeltas
 *   every `pollIntervalMs` so deltas keep flowing while degraded.
 *
 * Invariant — NO DELTA IS EVER SILENTLY DROPPED:
 * - events are applied sequentially on a single promise chain;
 * - LSN gap (`lsn !== lastApplied + 1`) ⇒ rebootstrap (never guess);
 * - redelivered events (`lsn <= lastApplied`) are skipped — at-least-once
 *   plus bloom idempotence makes redelivery harmless;
 * - a Rotate with an unexpected generation ⇒ rebootstrap;
 * - `applyEntry` failure (defense-in-depth validation rejected the item)
 *   ⇒ rebootstrap — the node cannot converge locally.
 *
 * Ordering contract: the persisted lastLsn is updated AFTER the event has
 * been applied (StateFile documents why the reverse would lose deltas).
 *
 * Degraded rotation: the node's core revoker runs with
 * rotateTime = coordinatorRotateTime × safetyFactor, so its own interval
 * fires only when coordinated rotations have been absent for the whole
 * safety window. The owner detects that via core's onRotation hook plus
 * `isRotationExternallyDriven()` and marks the state dirty. Dirty does not
 * interrupt the live engine: it keeps reconnecting/polling and catches up
 * incrementally (safe — while the coordinator is down, no new revocations
 * exist), and the snapshot rebootstrap happens on node restart (init).
 */
export class SyncEngine {
  readonly #options: SyncEngineOptions;
  readonly #logger: GenericLogger;
  readonly #pollIntervalMs: number;
  readonly #maxPollEvents: number;
  readonly #baseReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #delayFn: (ms: number) => Promise<void>;

  #mode: SyncEngineMode = 'idle';
  #lastAppliedLsn: number;
  #generation: number;
  #stream: SyncSubscription | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  /** Monotonic token invalidating pending reconnect sleeps on transitions. */
  #scheduleToken = 0;
  #reconnectAttempt = 0;
  #polling = false;
  /** True while a coordinated Rotate event is being applied (stream or poll). */
  #inCoordinatedRotation = false;
  #rebootstrapFired = false;
  #stopped = false;
  /** Serializes event application — one apply at a time, in arrival order. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: SyncEngineOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#lastAppliedLsn = options.initialLsn;
    this.#generation = options.initialGeneration;
    this.#pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.#maxPollEvents = options.maxPollEvents ?? 1000;
    this.#baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.#delayFn =
      options.delayFn ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  get mode(): SyncEngineMode {
    return this.#mode;
  }

  /** True while a live stream is open (primary channel healthy). */
  get connected(): boolean {
    return this.#mode === 'streaming';
  }

  get lastAppliedLsn(): number {
    return this.#lastAppliedLsn;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Whether the next core rotation is coordinator-driven (stream event or
   * poll-delivered Rotate being applied right now, or a healthy stream that
   * delivers rotations on schedule). The owner's onRotation hook uses this
   * to detect degraded SELF-rotation: when false, core rotated on its own
   * safety timer while disconnected ⇒ state must be marked dirty.
   */
  isRotationExternallyDriven(): boolean {
    return this.#mode === 'streaming' || this.#inCoordinatedRotation;
  }

  /** Opens the replication stream. */
  start(): void {
    if (this.#stopped) {
      return;
    }
    void this.#trySubscribe();
  }

  /**
   * Stops the engine: cancels the stream, clears timers, waits for the
   * apply chain to drain. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#mode = 'stopped';
    this.#scheduleToken++; // invalidate any pending reconnect sleep
    this.#stopPolling();
    this.#dropStream();
    await this.#chain;
  }

  /** Serialized application of one wire event (never rejects). */
  #enqueueApply(event: WireStreamEvent): Promise<void> {
    this.#chain = this.#chain.then(() => this.#applyEvent(event));
    return this.#chain;
  }

  async #trySubscribe(): Promise<void> {
    if (this.#stopped || this.#mode === 'streaming') {
      return;
    }
    try {
      const stream = await this.#options.client.subscribe(this.#lastAppliedLsn);
      if (this.#stopped) {
        stream.cancel();
        return;
      }
      this.#stream = stream;
      this.#mode = 'streaming';
      this.#reconnectAttempt = 0;
      this.#stopPolling();
      this.#logger.info(
        `Node ${this.#options.nodeId}: replication stream established at lsn ${this.#lastAppliedLsn}`
      );
      stream.on('data', (event) => {
        void this.#enqueueApply(event);
      });
      stream.on('error', (error) => {
        this.#handleStreamDown(stream, `stream error: ${error.message}`);
      });
      stream.on('end', () => {
        this.#handleStreamDown(stream, 'stream ended');
      });
    } catch (error) {
      if (this.#stopped) {
        return;
      }
      this.#logger.warn(
        `Node ${this.#options.nodeId}: subscribe failed: ${(error as Error).message}`
      );
      this.#enterReconnecting();
    }
  }

  /** Transitions to degraded mode: backoff reconnects + poll fallback. */
  #handleStreamDown(stream: SyncSubscription, reason: string): void {
    if (this.#stopped || this.#stream !== stream) {
      return; // stale event (already replaced / stopped)
    }
    this.#logger.warn(`Node ${this.#options.nodeId}: ${reason} — entering degraded mode`);
    this.#dropStream();
    this.#enterReconnecting();
  }

  #enterReconnecting(): void {
    if (this.#stopped || this.#mode === 'reconnecting') {
      // Already reconnecting — still make sure polling + retries run.
      if (!this.#stopped) {
        this.#startPolling();
        this.#scheduleReconnect();
      }
      return;
    }
    this.#mode = 'reconnecting';
    this.#startPolling();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) {
      return;
    }
    const rawDelay = Math.min(
      this.#baseReconnectDelayMs * 2 ** Math.min(this.#reconnectAttempt, 14),
      this.#maxReconnectDelayMs
    );
    const delayMs = withJitter(rawDelay);
    this.#reconnectAttempt++;
    const token = this.#scheduleToken;
    void this.#delayFn(delayMs).then(() => {
      if (this.#stopped || token !== this.#scheduleToken) {
        return; // superseded by a state transition or shutdown
      }
      return this.#trySubscribe();
    });
  }

  #startPolling(): void {
    if (this.#pollTimer || this.#stopped) {
      return;
    }
    this.#pollTimer = setInterval(() => {
      void this.#pollOnce();
    }, this.#pollIntervalMs);
  }

  #stopPolling(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** One degraded-mode poll: page through PollDeltas, apply via the chain. */
  async #pollOnce(): Promise<void> {
    if (this.#stopped || this.#polling || this.#mode === 'streaming') {
      return;
    }
    this.#polling = true;
    try {
      let pages = 0;
      let moreAvailable = true;
      while (moreAvailable && pages < MAX_POLL_PAGES && !this.#stopped && !this.connected) {
        const response = await this.#options.client.pollDeltas(
          this.#lastAppliedLsn,
          this.#maxPollEvents
        );
        if (this.#stopped) {
          return;
        }
        for (const event of response.events) {
          await this.#enqueueApply(event);
          if (this.#stopped || this.#rebootstrapFired) {
            return;
          }
        }
        moreAvailable = response.moreAvailable;
        pages++;
      }
    } catch (error) {
      // Coordinator still down — stay degraded, keep trying.
      this.#logger.debug(`Node ${this.#options.nodeId}: poll failed: ${(error as Error).message}`);
    } finally {
      this.#polling = false;
    }
  }

  /** Cancels and forgets the current stream without triggering handlers. */
  #dropStream(): void {
    const stream = this.#stream;
    this.#stream = null;
    if (!stream) {
      return;
    }
    stream.on('error', () => {
      // cancel() emits CANCELLED — swallow (must not become uncaught).
    });
    try {
      stream.cancel();
    } catch {
      // Already dead — nothing to cancel.
    }
  }

  /** Applies one wire event. Runs on the apply chain; never rejects. */
  async #applyEvent(event: WireStreamEvent): Promise<void> {
    if (this.#stopped || this.#rebootstrapFired) {
      return;
    }
    const kind = event.event;
    if (!kind || kind === 'keepalive') {
      return; // liveness only
    }
    if (kind === 'resnapshot') {
      this.#rebootstrap('coordinator sent ResnapshotRequired (retention floor exceeded)');
      return;
    }

    const payload: { lsn: string; generation: number; item?: string } | undefined =
      kind === 'entry' ? event.entry : event.rotate;
    const lsn = Number(payload?.lsn);
    if (!payload || !Number.isInteger(lsn) || lsn < 0 || !Number.isSafeInteger(lsn)) {
      this.#rebootstrap('malformed event lsn on the replication stream');
      return;
    }

    if (lsn <= this.#lastAppliedLsn) {
      return; // idempotent redelivery (at-least-once)
    }
    if (lsn !== this.#lastAppliedLsn + 1) {
      this.#rebootstrap(`LSN gap detected: expected ${this.#lastAppliedLsn + 1}, got ${lsn}`);
      return;
    }

    if (kind === 'entry') {
      try {
        // WAL-before-memory happens inside core's applyEntry.
        this.#options.revoker.applyEntry(payload.item as string);
      } catch (error) {
        this.#logger.error(
          `Node ${this.#options.nodeId}: failed to apply replicated entry at lsn ${lsn}: ` +
            `${(error as Error).message}`
        );
        this.#rebootstrap('unappliable replicated entry (never drop silently)');
        return;
      }
    } else {
      const expected = this.#generation + 1;
      if (payload.generation !== expected) {
        this.#logger.warn(
          `Node ${this.#options.nodeId}: rotation generation mismatch at lsn ${lsn} ` +
            `(expected ${expected}, got ${payload.generation})`
        );
        this.#rebootstrap('rotation generation mismatch');
        return;
      }
      this.#inCoordinatedRotation = true;
      try {
        await this.#options.revoker.rotateOnDemand();
      } catch (error) {
        this.#inCoordinatedRotation = false;
        this.#logger.error(
          `Node ${this.#options.nodeId}: coordinated rotation failed at lsn ${lsn}: ` +
            `${(error as Error).message}`
        );
        this.#rebootstrap('coordinated rotation failed');
        return;
      }
      this.#inCoordinatedRotation = false;
      this.#generation = expected;
      this.#logger.info(
        `Node ${this.#options.nodeId}: coordinated rotation applied ` +
          `(generation=${this.#generation}, lsn=${lsn})`
      );
    }

    // Persist AFTER apply — the ordering contract (see StateFile). The
    // engine never touches `dirty`: only the owner sets/clears it.
    this.#options.stateStore.update({ lastLsn: lsn, generation: this.#generation });
    this.#lastAppliedLsn = lsn;
  }

  /** Fires the rebootstrap callback once and stops all engine activity. */
  #rebootstrap(reason: string): void {
    if (this.#rebootstrapFired || this.#stopped) {
      return;
    }
    this.#rebootstrapFired = true;
    this.#logger.error(
      `Node ${this.#options.nodeId}: REBOOTSTRAP REQUIRED — ${reason}. ` +
        'Local replication state is discarded; the node will resync from the coordinator snapshot.'
    );
    this.#scheduleToken++; // cancel pending reconnect sleeps
    this.#stopPolling();
    this.#dropStream();
    this.#mode = 'reconnecting';
    this.#options.onRebootstrapRequired?.(reason);
  }
}
