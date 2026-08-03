import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { BloomFilterManager } from '../../src/Bloom-filter-manager.js';
import { Revoker } from '../../src/index.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

/**
 * Tests for the generic seams added for replication/coordination:
 * - `onRotation` observer hook (Task 1.1)
 * - `rotateOnDemand()` (Task 1.2)
 * - `applyEntry()` replication apply path (Task 1.3)
 *
 * Rotation tests use REAL timers (vitest forks pool) and short rotateTime
 * values, matching the convention in manager.spec.ts.
 */

describe('BloomFilterManager onRotation hook', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an onRotation option in the filter config', () => {
    const mgr = new BloomFilterManager({
      id: 'test-hook-config',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
      onRotation: () => {},
    });
    expect(mgr).toBeInstanceOf(BloomFilterManager);
    mgr.destroy();
  });

  it('rejects a non-function onRotation option', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test-hook-invalid',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          logger,
          onRotation: 'not-a-function' as any,
        })
    ).toThrow('Invalid input: "onRotation" must be of type function');
  });

  it('fires the hook once per successful rotation', async () => {
    const onRotation = vi.fn();
    const mgr = new BloomFilterManager({
      id: 'test-hook-fires',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 500,
      logger,
      onRotation,
    });

    await vi.waitFor(() => expect(onRotation).toHaveBeenCalledTimes(1), {
      timeout: 2000,
      interval: 20,
    });
    await vi.waitFor(() => expect(onRotation).toHaveBeenCalledTimes(2), {
      timeout: 2000,
      interval: 20,
    });

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('a throwing hook does not break rotation', async () => {
    const onRotation = vi.fn(() => {
      throw new Error('hook boom');
    });
    const mgr = new BloomFilterManager({
      id: 'test-hook-throw',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 500,
      logger,
      onRotation,
    });

    const first = mgr.current;
    // First rotation completes even though the hook throws...
    await vi.waitFor(() => expect(mgr.current).not.toBe(first), {
      timeout: 2000,
      interval: 20,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('onRotation hook error (ignored):'),
      expect.any(Error)
    );

    // ...and the rotation cycle continues on subsequent ticks.
    const second = mgr.current;
    await vi.waitFor(() => expect(mgr.current).not.toBe(second), {
      timeout: 2000,
      interval: 20,
    });
    expect(onRotation.mock.calls.length).toBeGreaterThanOrEqual(2);

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('hook errors from an async hook are caught (no unhandled rejection)', async () => {
    const onRotation = vi.fn(async () => {
      throw new Error('async hook boom');
    });
    const mgr = new BloomFilterManager({
      id: 'test-hook-async',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 500,
      logger,
      // async function assigned to the () => void seam — allowed by design
      onRotation: onRotation as unknown as () => void,
    });

    await vi.waitFor(
      () =>
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('onRotation hook error (ignored):'),
          expect.any(Error)
        ),
      { timeout: 2000, interval: 20 }
    );

    await mgr.resetAndClearData();
    mgr.destroy();
  });
});

describe('BloomFilterManager rotateOnDemand', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates immediately and keeps the interval running', async () => {
    // rotateTime far larger than the test duration: only the manual
    // rotation can happen here.
    const mgr = new BloomFilterManager({
      id: 'test-rod-now',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });

    const before = mgr.current;
    await mgr.rotateOnDemand();

    expect(mgr.current).not.toBe(before);
    expect(mgr.previous).toBe(before);
    expect(mgr.rotationInterval).not.toBeNull();
    expect(mgr.getMetrics().counters.rotations).toBe(1);

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('resets the rotation clock (next auto-rotation a full rotateTime later)', async () => {
    const rotateTime = 1500;
    const mgr = new BloomFilterManager({
      id: 'test-rod-clock',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime,
      logger,
    });

    // Let a large part of the original cycle elapse before rotating manually.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const beforeManual = mgr.current;
    await mgr.rotateOnDemand();
    expect(mgr.current).not.toBe(beforeManual);
    const afterManual = mgr.current;
    const t0 = Date.now();

    // If the clock had NOT been reset, the original interval would fire
    // ~600ms after the manual rotation (remaining original cycle time).
    // Fixed sleep here asserts a NEGATIVE window — vi.waitFor cannot.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mgr.current).toBe(afterManual);

    // Then the next rotation happens ~rotateTime after the manual one.
    await vi.waitFor(() => expect(mgr.current).not.toBe(afterManual), {
      timeout: 3000,
      interval: 20,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(rotateTime - 200);

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('is safe against concurrent automatic rotations (mutex contention)', async () => {
    // Short rotateTime so auto-rotations interleave with the manual ones.
    const mgr = new BloomFilterManager({
      id: 'test-rod-race',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 300,
      logger,
    });

    // Fire several manual rotations concurrently while the interval is live.
    await Promise.all([mgr.rotateOnDemand(), mgr.rotateOnDemand(), mgr.rotateOnDemand()]);

    // State stays consistent and the interval survives the race.
    expect(mgr.current).not.toBeNull();
    expect(mgr.previous).not.toBeNull();
    expect(mgr.rotationInterval).not.toBeNull();
    expect(mgr.getMetrics().counters.rotations).toBeGreaterThanOrEqual(3);

    // Rotation keeps happening afterwards.
    const after = mgr.current;
    await vi.waitFor(() => expect(mgr.current).not.toBe(after), {
      timeout: 2000,
      interval: 20,
    });

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('throws after shutdown', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-rod-shutdown',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    await mgr.shutdown();
    await expect(mgr.rotateOnDemand()).rejects.toThrow('revoker is shutting down');
  });
});

describe('BloomFilterManager applyEntry', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies an entry and makes it findable via has()', () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-basic',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    mgr.applyEntry('applied-token');
    expect(mgr.has('applied-token')).toBe(true);
    mgr.destroy();
  });

  it('persists to the WAL before updating the in-memory filter', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-wal',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
      backup: true,
    });
    const walPath = mgr.backupManager!.backupTempFilePath;

    // Make the in-memory add fail AFTER the WAL write: if applyEntry is
    // WAL-first, the item still reaches the WAL file.
    vi.spyOn(mgr.current!, 'add').mockImplementation(() => {
      throw new Error('memory add failed');
    });

    expect(() => mgr.applyEntry('wal-first-item')).toThrow('Failed to apply entry');

    const wal = fs.readFileSync(walPath, 'utf8');
    expect(wal).toContain('wal-first-item');
    // ...while memory never received it.
    vi.restoreAllMocks();
    expect(mgr.has('wal-first-item')).toBe(false);

    await mgr.resetAndClearData();
    mgr.destroy();
  });

  it('throws on invalid input (same validation as add)', () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-invalid',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });

    expect(() => mgr.applyEntry('')).toThrow('Value must be a non-empty string');
    expect(() => mgr.applyEntry(null as any)).toThrow('Value must be a non-empty string');
    expect(() => mgr.applyEntry('bad\nline')).toThrow(
      'Value must not contain line breaks or null characters'
    );
    expect(() => mgr.applyEntry('bad\0null')).toThrow(
      'Value must not contain line breaks or null characters'
    );
    expect(() => mgr.applyEntry('x'.repeat(4097))).toThrow('exceeds maximum length');

    mgr.destroy();
  });

  it('throws after shutdown', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-shutdown',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    await mgr.shutdown();
    expect(() => mgr.applyEntry('test')).toThrow('revoker is shutting down');
  });

  it('warns (rate-limited) instead of throwing when critically saturated', () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-sat',
      numItems: 10,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    const threshold = 10 * BloomFilterManager.MAX_SATURATION_RATIO; // 100

    // applyEntry never blocks, so it can fill past the saturation threshold.
    for (let i = 0; i <= threshold; i++) {
      mgr.applyEntry(`token-${i}`);
    }
    logger.warn.mockClear();

    // Saturated applies: no throw; the warn is rate-limited to a single call.
    mgr.applyEntry('overflow-1');
    mgr.applyEntry('overflow-2');
    mgr.applyEntry('overflow-3');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const metrics = mgr.getMetrics();
    expect(metrics.counters.appliedSaturationWarned).toBe(3);
    expect(metrics.counters.applied).toBe(threshold + 1 + 3);
    // The entry is still applied (no silent drop).
    expect(mgr.has('overflow-3')).toBe(true);

    mgr.destroy();
  });

  it('getMetrics exposes the applyEntry counters', () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-counters',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    mgr.applyEntry('a');
    mgr.applyEntry('b');

    const metrics = mgr.getMetrics();
    expect(metrics.counters.applied).toBe(2);
    expect(metrics.counters.appliedSaturationWarned).toBe(0);
    // applyEntry does not touch the admin add() counters.
    expect(metrics.counters.addSucceeded).toBe(0);
    expect(metrics.counters.addFailed).toBe(0);

    mgr.destroy();
  });

  it('resetAndRestore resets the applyEntry counters', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-apply-reset',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
      logger,
    });
    mgr.applyEntry('x');
    await mgr.resetAndRestore();
    expect(mgr.getMetrics().counters.applied).toBe(0);
    expect(mgr.getMetrics().counters.appliedSaturationWarned).toBe(0);

    await mgr.resetAndClearData();
    mgr.destroy();
  });
});

describe('Revoker applyEntry / rotateOnDemand passthroughs', () => {
  let logger: MockLogger;

  const makeRevoker = (overrides: Record<string, unknown> = {}) =>
    new Revoker({
      id: 'test-revoker-seams',
      claimsToCheck: ['jti'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 60000 },
      ...overrides,
    } as any);

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applyEntry applies entries through the manager', async () => {
    const revoker = makeRevoker();
    revoker.applyEntry('jti-123');
    expect(revoker.has('jti-123')).toBe(true);
    expect(revoker.getMetrics().counters.applied).toBe(1);
    await revoker.destroy();
  });

  it('applyEntry propagates validation errors', async () => {
    const revoker = makeRevoker();
    expect(() => revoker.applyEntry('')).toThrow('Value must be a non-empty string');
    await revoker.destroy();
  });

  it('rotateOnDemand rotates through the manager', async () => {
    const revoker = makeRevoker();
    const before = revoker.bloomFilterManager!.current;
    await revoker.rotateOnDemand();
    expect(revoker.bloomFilterManager!.current).not.toBe(before);
    expect(revoker.bloomFilterManager!.previous).toBe(before);
    await revoker.destroy();
  });

  it('applyEntry and rotateOnDemand throw when gRPC is enabled', async () => {
    // Same pattern as the existing gRPC-guard tests: construct with
    // grpcEnabled but never call _grpcInit(), so no server starts.
    const revoker = makeRevoker({ grpcEnabled: true, grpcPort: 50051 });
    expect(() => revoker.applyEntry('test')).toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
    await expect(revoker.rotateOnDemand()).rejects.toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
    await revoker.destroy();
  });

  it('applyEntry and rotateOnDemand throw when the manager is missing', async () => {
    const revoker = makeRevoker();
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    expect(() => revoker.applyEntry('test')).toThrow('Bloom filter manager not initialized');
    await expect(revoker.rotateOnDemand()).rejects.toThrow(
      'Bloom filter manager not initialized'
    );
    await revoker.destroy();
  });
});
