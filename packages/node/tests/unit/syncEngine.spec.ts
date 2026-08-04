import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine, type SyncSubscription } from '../../src/syncEngine.js';
import type { WireStreamEvent } from '../../src/types.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * Unit tests for the node replication state machine, with stubbed
 * revoker/client/state-store: ordering, gap ⇒ rebootstrap, apply-before-
 * persist ordering, degraded-mode poll fallback, backoff progression and
 * the degraded self-rotation detection contract.
 */

class FakeStream implements SyncSubscription {
  #listeners = new Map<string, Array<(...args: any[]) => void>>();
  cancelled = false;

  on(event: 'data', listener: (event: WireStreamEvent) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  cancel(): void {
    this.cancelled = true;
  }
}

const entry = (lsn: number, item: string, generation = 0): WireStreamEvent => ({
  event: 'entry',
  entry: { lsn: String(lsn), generation, item },
});

const rotate = (lsn: number, generation: number): WireStreamEvent => ({
  event: 'rotate',
  rotate: { lsn: String(lsn), generation },
});

const keepalive = (): WireStreamEvent => ({ event: 'keepalive', keepalive: {} });

const resnapshot = (generation: number): WireStreamEvent => ({
  event: 'resnapshot',
  resnapshot: { generation },
});

interface Harness {
  engine: SyncEngine;
  stream: FakeStream;
  timeline: string[];
  updates: Array<{ lastLsn: number; generation: number; dirty?: boolean }>;
  rebootstrapReasons: string[];
  subscribe: ReturnType<typeof vi.fn>;
  pollDeltas: ReturnType<typeof vi.fn>;
  applyEntry: ReturnType<typeof vi.fn>;
  rotateOnDemand: ReturnType<typeof vi.fn>;
}

function makeHarness(
  options: {
    initialLsn?: number;
    initialGeneration?: number;
    pollIntervalMs?: number;
    baseReconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    delayFn?: (ms: number) => Promise<void>;
    subscribeImpl?: (lastLsn: number) => Promise<SyncSubscription>;
    pollImpl?: (
      fromLsn: number,
      maxEvents: number
    ) => Promise<{
      events: WireStreamEvent[];
      moreAvailable: boolean;
    }>;
    rotateImpl?: () => Promise<void>;
  } = {}
): Harness {
  const timeline: string[] = [];
  const updates: Array<{ lastLsn: number; generation: number; dirty?: boolean }> = [];
  const rebootstrapReasons: string[] = [];
  const stream = new FakeStream();

  const applyEntry = vi.fn((item: string) => {
    timeline.push(`apply:${item}`);
  });
  const rotateOnDemand = vi.fn(
    options.rotateImpl ??
      (async () => {
        timeline.push('rotate');
      })
  );
  const subscribe = vi.fn(options.subscribeImpl ?? (async () => stream as SyncSubscription));
  const pollDeltas = vi.fn(
    options.pollImpl ?? (async () => ({ events: [] as WireStreamEvent[], moreAvailable: false }))
  );

  const engine = new SyncEngine({
    nodeId: 'node-a',
    revoker: { applyEntry, rotateOnDemand },
    client: { subscribe, pollDeltas },
    stateStore: {
      update: (state) => {
        timeline.push(`state:${state.lastLsn}`);
        updates.push({ ...state });
      },
    },
    logger: createMockLogger(),
    initialLsn: options.initialLsn ?? 0,
    initialGeneration: options.initialGeneration ?? 0,
    pollIntervalMs: options.pollIntervalMs ?? 60_000, // off unless the test wants it
    baseReconnectDelayMs: options.baseReconnectDelayMs ?? 5,
    maxReconnectDelayMs: options.maxReconnectDelayMs ?? 40,
    delayFn: options.delayFn,
    onRebootstrapRequired: (reason) => rebootstrapReasons.push(reason),
  });

  return {
    engine,
    stream,
    timeline,
    updates,
    rebootstrapReasons,
    subscribe,
    pollDeltas,
    applyEntry,
    rotateOnDemand,
  };
}

describe('SyncEngine event application', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.engine.stop();
      harness = null;
    }
  });

  it('applies entries in order and persists state AFTER each apply', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', entry(1, 't1'));
    harness.stream.emit('data', entry(2, 't2'));

    await vi.waitFor(() =>
      expect(harness?.timeline).toEqual(['apply:t1', 'state:1', 'apply:t2', 'state:2'])
    );
    expect(harness.updates).toEqual([
      { lastLsn: 1, generation: 0 },
      { lastLsn: 2, generation: 0 },
    ]);
    expect(harness.engine.lastAppliedLsn).toBe(2);
  });

  it('skips redelivered events (at-least-once idempotence)', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', entry(1, 't1'));
    await vi.waitFor(() => expect(harness?.engine.lastAppliedLsn).toBe(1));
    harness.stream.emit('data', entry(1, 't1'));
    // Give the duplicated event a chance to (wrongly) apply.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.applyEntry).toHaveBeenCalledTimes(1);
    expect(harness.updates).toHaveLength(1);
    expect(harness.rebootstrapReasons).toHaveLength(0);
  });

  it('ignores keepalives (no state change, no rebootstrap)', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', keepalive());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(harness.engine.lastAppliedLsn).toBe(0);
    expect(harness.updates).toHaveLength(0);
    expect(harness.rebootstrapReasons).toHaveLength(0);
  });

  it('an LSN gap triggers rebootstrap and does NOT apply the event', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', entry(1, 't1'));
    await vi.waitFor(() => expect(harness?.engine.lastAppliedLsn).toBe(1));
    harness.stream.emit('data', entry(3, 't3')); // gap: expected 2

    await vi.waitFor(() => expect(harness?.rebootstrapReasons).toHaveLength(1));
    expect(harness.rebootstrapReasons[0]).toMatch(/LSN gap/);
    expect(harness.applyEntry).toHaveBeenCalledTimes(1); // only t1
    expect(harness.stream.cancelled).toBe(true);
    expect(harness.engine.lastAppliedLsn).toBe(1); // never advanced past the gap
  });

  it('ResnapshotRequired triggers rebootstrap', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', resnapshot(5));

    await vi.waitFor(() => expect(harness?.rebootstrapReasons).toHaveLength(1));
    expect(harness.rebootstrapReasons[0]).toMatch(/ResnapshotRequired/);
  });

  it('applies a coordinated rotation and advances the generation', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', entry(1, 't1'));
    harness.stream.emit('data', rotate(2, 1));
    harness.stream.emit('data', entry(3, 't3', 1));

    await vi.waitFor(() => expect(harness?.engine.lastAppliedLsn).toBe(3));
    expect(harness.rotateOnDemand).toHaveBeenCalledTimes(1);
    expect(harness.engine.generation).toBe(1);
    expect(harness.updates.at(-1)).toEqual({ lastLsn: 3, generation: 1 });
    expect(harness.rebootstrapReasons).toHaveLength(0);
  });

  it('a generation mismatch triggers rebootstrap without rotating', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', rotate(1, 5)); // expected generation 1, got 5

    await vi.waitFor(() => expect(harness?.rebootstrapReasons).toHaveLength(1));
    expect(harness.rebootstrapReasons[0]).toMatch(/generation mismatch/);
    expect(harness.rotateOnDemand).not.toHaveBeenCalled();
    expect(harness.engine.generation).toBe(0);
  });

  it('an unappliable entry (applyEntry throws) triggers rebootstrap', async () => {
    harness = makeHarness();
    harness.applyEntry.mockImplementation((item: string) => {
      if (item === 'bad') {
        throw new Error('Value must be a non-empty string');
      }
    });
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', entry(1, 'bad'));

    await vi.waitFor(() => expect(harness?.rebootstrapReasons).toHaveLength(1));
    expect(harness.rebootstrapReasons[0]).toMatch(/unappliable/);
    expect(harness.engine.lastAppliedLsn).toBe(0); // never persisted
  });

  it('a failed coordinated rotation triggers rebootstrap', async () => {
    harness = makeHarness({
      rotateImpl: async () => {
        throw new Error('disk gone');
      },
    });
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    harness.stream.emit('data', rotate(1, 1));

    await vi.waitFor(() => expect(harness?.rebootstrapReasons).toHaveLength(1));
    expect(harness.rebootstrapReasons[0]).toMatch(/rotation failed/);
    expect(harness.engine.generation).toBe(0);
  });
});

describe('SyncEngine degraded mode', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.engine.stop();
      harness = null;
    }
  });

  it('stream error ⇒ reconnecting, poll fallback applies deltas, then resubscribes', async () => {
    const streams: FakeStream[] = [];
    let pollCalls = 0;
    harness = makeHarness({
      pollIntervalMs: 15,
      // Reconnect slower than the poll cadence so the degraded poll runs
      // first (this test is about the poll fallback, not the reconnect).
      baseReconnectDelayMs: 100,
      maxReconnectDelayMs: 500,
      subscribeImpl: async () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream as SyncSubscription;
      },
      pollImpl: async () => {
        pollCalls++;
        if (pollCalls === 1) {
          return { events: [entry(1, 'polled')], moreAvailable: false };
        }
        return { events: [], moreAvailable: false };
      },
    });

    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));
    expect(harness.engine.mode).toBe('streaming');

    streams[0].emit('error', new Error('connection reset'));
    await vi.waitFor(() => expect(harness?.engine.mode).toBe('reconnecting'));

    // Degraded poll delivers the delta through the same apply pipeline.
    await vi.waitFor(() => expect(harness?.engine.lastAppliedLsn).toBe(1));
    expect(harness.applyEntry).toHaveBeenCalledWith('polled');

    // Reconnect attempts resume (eventually a new stream is opened).
    await vi.waitFor(() => expect(streams.length).toBeGreaterThan(1), { timeout: 5000 });
  });

  it('subscribe failures keep retrying with growing backoff delays', async () => {
    const delays: number[] = [];
    harness = makeHarness({
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 100,
      // Yield to the event loop between attempts: an immediately-resolving
      // delay would create a microtask-only retry loop that starves timers.
      delayFn: (ms) => {
        delays.push(ms);
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      subscribeImpl: async () => {
        throw new Error('coordinator down');
      },
    });

    harness.engine.start();
    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(5), { timeout: 5000 });

    expect(harness.engine.mode).toBe('reconnecting');
    // Strictly increasing until the cap (jitter ±20% on a doubling base
    // keeps the minimum ratio at 2 × 0.8/1.2 ≈ 1.33 > 1).
    for (let i = 1; i < 4; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    // Never above the cap (+ jitter headroom).
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(100 * 1.2);
    }
    // First delay ≈ base (within jitter).
    expect(delays[0]).toBeGreaterThanOrEqual(8);
    expect(delays[0]).toBeLessThanOrEqual(12);
  });

  it('isRotationExternallyDriven: true while streaming or mid-coordinated-rotation', async () => {
    const rotationGate: { resolve: (() => void) | null } = { resolve: null };
    harness = makeHarness({
      // Poll faster than the reconnect so the degraded poll delivers the
      // coordinated Rotate while the engine is still reconnecting.
      pollIntervalMs: 10,
      baseReconnectDelayMs: 500,
      maxReconnectDelayMs: 1000,
      rotateImpl: () =>
        new Promise<void>((resolve) => {
          rotationGate.resolve = resolve;
        }),
    });
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    // Healthy stream ⇒ rotations are delivered on schedule ⇒ externally driven.
    expect(harness.engine.isRotationExternallyDriven()).toBe(true);

    // Take the stream down: degraded, no rotation in flight ⇒ NOT driven
    // (a core rotation now would be a self-rotation ⇒ dirty).
    harness.stream.emit('error', new Error('down'));
    await vi.waitFor(() => expect(harness?.engine.mode).toBe('reconnecting'));
    expect(harness.engine.isRotationExternallyDriven()).toBe(false);

    // A coordinated Rotate arriving via ANY channel marks the window driven
    // again while it is being applied.
    harness.pollDeltas.mockImplementationOnce(async () => ({
      events: [rotate(1, 1)],
      moreAvailable: false,
    }));
    await vi.waitFor(() => expect(harness?.rotateOnDemand).toHaveBeenCalled(), { timeout: 5000 });
    // Rotation is pending (blocked on the gate) ⇒ driven.
    expect(harness.engine.isRotationExternallyDriven()).toBe(true);

    rotationGate.resolve?.();
    await vi.waitFor(() => expect(harness?.engine.generation).toBe(1));
  });

  it('stop() cancels the stream and halts application', async () => {
    harness = makeHarness();
    harness.engine.start();
    await vi.waitFor(() => expect(harness?.engine.connected).toBe(true));

    await harness.engine.stop();
    expect(harness.stream.cancelled).toBe(true);
    expect(harness.engine.mode).toBe('stopped');

    harness.stream.emit('data', entry(1, 'late'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.applyEntry).not.toHaveBeenCalled();
    harness = null; // already stopped
  });
});
