import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BloomFilterManager } from '../../src/Bloom-filter-manager.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

describe('BloomFilterManager Constructor Validation', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructor throws error when numItems is not provided', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          fpRate: 0.01,
          rotateTime: 1000,
          logger,
        } as any)
    ).toThrow('Invalid input: "numItems" is required');
  });

  it('constructor throws error when numItems is not an integer', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000.5,
          fpRate: 0.01,
          rotateTime: 1000,
          logger,
        })
    ).toThrow('Invalid input: "numItems" must be an integer');
  });

  it('constructor throws error for invalid numItems', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: -1,
          fpRate: 0.01,
          rotateTime: 1000,
          logger,
        })
    ).toThrow('Invalid input: "numItems" must be a positive number');
  });

  it('constructor throws error when fpRate is not provided', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          rotateTime: 1000,
          logger,
        } as any)
    ).toThrow('Invalid input: "fpRate" is required');
  });

  it('constructor throws error for invalid fpRate > 1', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 1.5,
          rotateTime: 1000,
          logger,
        })
    ).toThrow('Invalid input: "fpRate" must be less than 1');
  });

  it('constructor throws error for fpRate === 1 (exclusive bound)', () => {
    // fpRate = 1 would compute a degenerate filter (m = 0) where every has()
    // returns true — a total fail-closed denial of service.
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 1,
          rotateTime: 1000,
          logger,
        })
    ).toThrow('Invalid input: "fpRate" must be less than 1');
  });

  it('constructor throws error for invalid fpRate < 0', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: -0.5,
          rotateTime: 1000,
          logger,
        })
    ).toThrow('Invalid input: "fpRate" must be a positive number');
  });

  it('constructor throws error when rotateTime is not provided', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          logger,
        } as any)
    ).toThrow('Invalid input: "rotateTime" is required');
  });

  it('constructor throws error when rotateTime is not an integer', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000.5,
          logger,
        })
    ).toThrow('Invalid input: "rotateTime" must be an integer');
  });

  it('constructor throws error for invalid rotateTime', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 0,
          logger,
        })
    ).toThrow('Invalid input: "rotateTime" must be a positive number');
  });

  it('constructor throws error when backup is not a boolean', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          backup: 'true' as any,
          logger,
        })
    ).toThrow('Invalid input: "backup" must be a boolean');
  });

  it('constructor throws error when backupTime is provided and backup is not provided', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          backup: false,
          backupTime: 500,
          logger,
        } as any)
    ).toThrow('Invalid input: "backupTime" is not allowed');
  });

  it('constructor throws error when backupRatioTime is provided and backup is false', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          backup: false,
          backupRatioTime: 5,
          logger,
        })
    ).toThrow('Invalid input: "backupRatioTime" is not allowed');
  });

  it('constructor throws error when backupRatioTime is not a positive integer', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          backup: true,
          backupRatioTime: -5,
          logger,
        })
    ).toThrow('Invalid input: "backupRatioTime" must be a positive number');
  });

  it('constructor throws error when backupRatioTime is not an integer', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          backup: true,
          backupRatioTime: 2.5,
          logger,
        })
    ).toThrow('Invalid input: "backupRatioTime" must be an integer');
  });

  it('constructor throws error if logger is not an object', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          logger: 'console' as any,
        })
    ).toThrow('Invalid input: "logger" must be of type object');
  });

  it('constructor throws error if logger is not an object with required methods', () => {
    expect(
      () =>
        new BloomFilterManager({
          id: 'test',
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
          } as any,
        })
    ).toThrow('Invalid input: "logger.error" is required');
  });
});

describe('BloomFilterManager Add and Has', () => {
  let manager: BloomFilterManager;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 2000,
      logger,
      backup: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.resetAndClearData();
    manager.destroy();
  });

  it('add method adds a string value', () => {
    manager.add('testValue');
    expect(manager.has('testValue')).toBe(true);
  });

  it('add adds a value to the current filter', () => {
    const value = 'testValue';
    manager.add(value);
    expect(manager.has(value)).toBe(true);
  });

  it('add throw an error if value is empty', () => {
    expect(() => manager.add('')).toThrow('Value must be a non-empty string');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('add throw an error if value is not a string', () => {
    expect(() => manager.add(123 as any)).toThrow('Value must be a non-empty string');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('add throw an error when write to file failed', () => {
    vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('Mocked write error');
    });
    expect(() => manager.add('test')).toThrow('Mocked write error');
  });

  it('has method returns true for added values', () => {
    const value = 'testValue';
    manager.add(value);
    expect(manager.has(value)).toBe(true);
  });

  it('has returns false for a value not added', async () => {
    const value = 'nonExistent';
    await manager.resetAndClearData();
    expect(manager.has(value)).toBe(false);
  });

  it('has returns true for a value added to the previous filter after rotation', async () => {
    const value = 'testValue';
    manager.add(value);
    // Wait for an actual rotation (rotateTime = 2000ms) so `value` moves to the
    // previous filter; `previous` is populated only once the rotation completes.
    await vi.waitFor(() => expect(manager.previous).not.toBeNull(), {
      timeout: 3500,
      interval: 20,
    });
    expect(manager.has(value)).toBe(true);
  });

  it('has throws an error if value is empty', () => {
    expect(() => manager.has('')).toThrow('Value must be a non-empty string');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('has throws an error if value is not a string', () => {
    expect(() => manager.has(123 as any)).toThrow('Value must be a non-empty string');
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('BloomFilterManager ResetAndRestore, ResetAndClearData and Destroy', () => {
  let manager: BloomFilterManager;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 1000,
      logger,
      backup: true,
      backupRatioTime: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.destroy();
  });

  it('resetAndRestore method clears the Bloom filters and restore', async () => {
    manager.add('testValue');
    await manager.resetAndRestore();
    expect(manager.has('testValue')).toBe(true);
    await manager.resetAndClearData();
  });

  it('resetAndRestore resets timers and restore intervall', async () => {
    manager.add('testValue');
    await manager.resetAndRestore();
    expect(logger.debug).toHaveBeenCalledWith(`Rotation stopped for id: ${manager.id}`);
    expect(logger.debug).toHaveBeenCalledWith(`Rotation stopped for id: ${manager.id}`);
    expect(manager.rotationInterval).not.toBe(null);
    expect(manager.backupManager?.backupInterval).not.toBe(null);
    await manager.resetAndClearData();
  });

  it('resetAndRestore resets filters and restores backup temp files', async () => {
    vi.clearAllMocks();
    manager.add('testValue');
    await manager.resetAndRestore();
    expect(logger.debug).toHaveBeenCalledWith('Bloom filters reset');
    expect(logger.debug).toHaveBeenCalledWith(
      `Elements restored from temp file for instance : ${manager.id}`
    );
    expect(manager.has('testValue')).toBe(true);
    expect(manager.current).not.toBe(null);
    expect(manager.previous).toBe(null);
    await manager.resetAndClearData();
  });

  it('resetAndRestore reset filters and restore backup files after backup', async () => {
    vi.clearAllMocks();
    manager.add('testValue');

    // Wait for the scheduled backup to actually complete (interval = rotateTime / backupRatioTime).
    await vi.waitFor(
      () => {
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('Saved current filter to:')
        );
        expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
      },
      { timeout: 2000, interval: 20 }
    );
    manager.add('testValue2');

    await manager.resetAndRestore();

    expect(logger.debug).toHaveBeenCalledWith('Bloom filters reset');
    expect(logger.debug).toHaveBeenCalledWith(`Restored current filter : id ${manager.id}`);
    expect(logger.debug).toHaveBeenCalledWith(
      `Elements restored from temp file for instance : ${manager.id}`
    );
    expect(manager.has('testValue')).toBe(true);
    expect(manager.has('testValue2')).toBe(true);
    await manager.resetAndClearData();
  });

  it('resetAndRestore reset filters and restore backup files after backup and rotation', async () => {
    manager.add('testValue');
    await vi.waitFor(
      () => {
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('Saved current filter to:')
        );
        expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
      },
      { timeout: 2000, interval: 20 }
    );
    manager.add('testValue2');
    // Wait for the rotation to FULLY complete: `previous` is only assigned after
    // the rotation-time backup has flushed the blob and cleared the WAL, so adding
    // testValue3 afterwards cannot be wiped by an in-flight backup.
    await vi.waitFor(() => expect(manager.previous).not.toBeNull(), {
      timeout: 2000,
      interval: 20,
    });
    expect(logger.debug).toHaveBeenCalledWith('Rotating Bloom filters...');
    manager.add('testValue3');
    await manager.resetAndRestore();
    expect(manager.has('testValue')).toBe(true);
    expect(manager.has('testValue2')).toBe(true);
    expect(manager.has('testValue3')).toBe(true);
    await manager.resetAndClearData();
  });

  it('resetAndClearData method clears the Bloom filters and clear data', async () => {
    manager.add('testValue');
    await manager.resetAndClearData();
    expect(manager.has('testValue')).toBe(false);
  });

  it('resetAndClearData resets filters and deletes backup files', async () => {
    manager.add('testValue');
    await vi.waitFor(
      () => {
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('Saved current filter to:')
        );
        expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
      },
      { timeout: 2000, interval: 20 }
    );
    manager.add('testValue2');
    // Same rationale as above: wait for the rotation-time backup to finish.
    await vi.waitFor(() => expect(manager.previous).not.toBeNull(), {
      timeout: 2000,
      interval: 20,
    });
    expect(logger.debug).toHaveBeenCalledWith('Rotating Bloom filters...');
    manager.add('testValue3');
    await manager.resetAndClearData();
    expect(manager.has('testValue')).toBe(false);
    expect(manager.has('testValue2')).toBe(false);
    expect(manager.has('testValue3')).toBe(false);
  });

  it('resetAndClearData sets hasRotated to false', async () => {
    await manager.resetAndClearData();
    expect(manager.hasRotated).toBe(false);
  });

  it('destroy method properly cleans up the manager', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    manager.destroy();
    expect(manager.previous).toBeNull();
    expect(manager.current).toBeNull();
    expect(manager.rotationInterval).toBeNull();
    expect(manager.backupManager).toBeNull();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    clearIntervalSpy.mockRestore();
  });
});

describe('BloomFilterManager Rotation', () => {
  let manager: BloomFilterManager;
  let logger: MockLogger;

  beforeAll(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 500,
      logger,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await manager.resetAndClearData();
    manager.destroy();
  });

  it('rotate switches current to previous and creates a new current', async () => {
    const initialCurrent = manager.current;
    await vi.waitFor(
      () => {
        expect(manager.previous).toBe(initialCurrent);
        expect(manager.current).not.toBe(initialCurrent);
      },
      { timeout: 2000, interval: 20 }
    );
  });

  it('rotate set hasRotated to true', async () => {
    await manager.resetAndClearData();
    await vi.waitFor(() => expect(manager.hasRotated).toBe(true), { timeout: 2000, interval: 20 });
    manager.hasRotated = false;
    await vi.waitFor(() => expect(manager.hasRotated).toBe(true), { timeout: 2000, interval: 20 });
  });

  it('rotate is called after rotateTime', async () => {
    const initialCurrent = manager.current;
    await vi.waitFor(
      () => {
        expect(manager.previous).toBe(initialCurrent);
        expect(manager.current).not.toBe(initialCurrent);
      },
      { timeout: 2000, interval: 20 }
    );
  });

  it('filters rotate correctly after rotateTime', async () => {
    manager.add('value1');
    expect(manager.has('value1')).toBe(true);
    const currentBefore = manager.current;
    await vi.waitFor(() => expect(manager.current).not.toBe(currentBefore), {
      timeout: 2000,
      interval: 20,
    });
    manager.add('value2');
    expect(manager.has('value1')).toBe(true);
    expect(manager.has('value2')).toBe(true);
  });
});

describe('BloomFilterManager metrics', () => {
  let manager: BloomFilterManager;
  let logger: MockLogger;
  const NUMITEMS = 10000;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 10000,
      fpRate: 0.0001,
      rotateTime: 500,
      logger,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.resetAndClearData();
    manager.destroy();
  });

  it('getMetrics returns correct values after init', async () => {
    logger.info.mockClear();
    const metrics = manager.getMetrics();
    expect(metrics.estimatedMetrics.currentCount).toBe(-0);
    expect(metrics.estimatedMetrics.currentFpRate).toBe(0);
    expect(metrics.estimatedMetrics.previousCount).toBe(0);
    expect(metrics.estimatedMetrics.previousFpRate).toBe(0);
    expect(metrics.configuration.numItems).toBe(NUMITEMS);
    expect(metrics.configuration.fpRate).toBe(0.0001);
    expect(metrics.configuration.rotateTime).toBe(500);
    expect(metrics.configuration.backupEnabled).toBe(false);
    expect((metrics.configuration as any).backupTime).toBe(undefined);
  });

  it('getEstimatedMetricx returns correct values after filling current filter', async () => {
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString());
    }
    const metrics = manager.getMetrics().estimatedMetrics;
    expect(metrics.currentCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.currentCount).toBeLessThan(NUMITEMS + 50);
    expect(metrics.currentFpRate).toBeCloseTo(0.0001, 4);
    expect(metrics.previousCount).toBe(0);
    expect(metrics.previousFpRate).toBe(0);
  });

  it('getEstimatedMetrics returns correct values after rotation', async () => {
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString());
    }
    // Wait for the rotation to fully complete (`previous` is populated only after
    // the rotation-time backup finishes) before filling the new current filter.
    await vi.waitFor(() => expect(manager.previous).not.toBeNull(), {
      timeout: 2000,
      interval: 20,
    });
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString());
    }
    const metrics = manager.getMetrics().estimatedMetrics;
    expect(metrics.currentCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.currentCount).toBeLessThan(NUMITEMS + 50);
    expect(metrics.currentFpRate).toBeCloseTo(0.0001, 4);
    expect(metrics.previousCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.previousCount).toBeLessThan(NUMITEMS + 50);
    expect(metrics.previousFpRate).toBeCloseTo(0.0001, 4);
  });
});

describe('BloomFilterBackupManager restore and edge cases', () => {
  let manager: BloomFilterManager;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 2000,
      logger,
      backup: true,
      backupRatioTime: 2,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.resetAndClearData();
    manager.destroy();
  });

  it('restore throws for invalid filterName', () => {
    expect(() => manager.backupManager!.restore('invalid')).toThrow(
      "filterName parameter must be either 'current', 'previous', or 'all'"
    );
  });

  it('restore with "current" only restores the current filter', async () => {
    manager.add('hello');
    // Wait for the scheduled backup to actually complete (interval = rotateTime / backupRatioTime).
    await vi.waitFor(
      () =>
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('Saved current filter to:')
        ),
      { timeout: 3000, interval: 20 }
    );
    // Now restore only the current filter
    const restored = manager.backupManager!.restore('current');
    expect(restored.current).not.toBeNull();
    // previous should be null since we asked only for current and there was no previous backup
  });

  it('restore warns when no backup file exists', async () => {
    await manager.resetAndClearData();
    logger.debug.mockClear();
    logger.warn.mockClear();
    manager.backupManager!.restore('current');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No current backup to restore')
    );
  });

  it('resetAndRestore propagates errors from internal operations', async () => {
    // Throw inside the try block — e.g., make logger.debug throw
    const origDebug = logger.debug;
    logger.debug = vi.fn(() => {
      throw new Error('Debug crash');
    });
    await expect(manager.resetAndRestore()).rejects.toThrow(
      'Failed to reset and restore: Debug crash'
    );
    logger.debug = origDebug;
  });

  it('deleteBackupFile deletes an existing file and logs', () => {
    const fs = require('node:fs');
    const tmpPath = manager.backupManager!.backupTempFilePath;
    fs.writeFileSync(tmpPath, 'test\n');
    logger.debug.mockClear();
    manager.backupManager!.deleteBackupFile(tmpPath, 'Test');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Test backup file deleted for instance')
    );
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('deleteBackupFile does nothing if file does not exist', () => {
    const nonExistent = '/tmp/nonexistent-bloom-backup-test.blob';
    logger.debug.mockClear();
    expect(() => manager.backupManager!.deleteBackupFile(nonExistent, 'Ghost')).not.toThrow();
    // No deletion log since file doesn't exist
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Ghost backup file deleted')
    );
  });

  it('bufferEnabled creates write interval', () => {
    const mgr = new BloomFilterManager({
      id: 'test-buf',
      numItems: 100,
      fpRate: 0.01,
      rotateTime: 5000,
      logger,
      backup: true,
      bufferEnabled: true,
      backupRatioTime: 2,
    });
    expect(mgr.backupManager!.bufferEnabled).toBe(true);
    expect(mgr.backupManager!.writeInterval).not.toBeNull();
    mgr.destroy();
  });

  it('bufferEnabled backupItem pushes to writeBuffer instead of writing to file', () => {
    const mgr = new BloomFilterManager({
      id: 'test-buf2',
      numItems: 100,
      fpRate: 0.01,
      rotateTime: 5000,
      logger,
      backup: true,
      bufferEnabled: true,
      backupRatioTime: 2,
    });
    const writeBufferLen = mgr.backupManager!.writeBuffer.length;
    mgr.backupManager!.backupItem('test-item');
    expect(mgr.backupManager!.writeBuffer.length).toBe(writeBufferLen + 1);
    expect(mgr.backupManager!.writeBuffer).toContain('test-item');
    mgr.destroy();
  });

  it('resetAndClearData propagates errors from internal operations', async () => {
    vi.spyOn(manager.backupManager!, 'deleteBackupFile').mockImplementation(() => {
      throw new Error('Delete failed');
    });
    await expect(manager.resetAndClearData()).rejects.toThrow(
      'Failed to reset and clear data: Delete failed'
    );
  });

  it('bufferMaxSize defaults to numItems * 2', () => {
    const mgr = new BloomFilterManager({
      id: 'test-buf-max',
      numItems: 100,
      fpRate: 0.01,
      rotateTime: 5000,
      logger,
      backup: true,
      bufferEnabled: true,
      backupRatioTime: 2,
    });
    expect(mgr.backupManager!.maxBufferSize).toBe(200);
    mgr.destroy();
  });

  it('bufferEnabled backupItem throws when buffer is full', () => {
    const mgr = new BloomFilterManager({
      id: 'test-buf-full',
      numItems: 10,
      fpRate: 0.01,
      rotateTime: 5000,
      logger,
      backup: true,
      bufferEnabled: true,
      bufferMaxSize: 100,
      backupRatioTime: 2,
    });
    for (let i = 0; i < 100; i++) {
      mgr.backupManager!.backupItem(`item-${i}`);
    }
    expect(() => mgr.backupManager!.backupItem('overflow')).toThrow('Write buffer full');
    mgr.destroy();
  });

  it('add() rejects when critically saturated', () => {
    const mgr = new BloomFilterManager({
      id: 'test-sat',
      numItems: 10,
      fpRate: 0.01,
      rotateTime: 50000,
      logger,
    });
    const threshold = 10 * BloomFilterManager.MAX_SATURATION_RATIO;
    // Fill past the saturation threshold
    for (let i = 0; i <= threshold; i++) {
      mgr.add(`token-${i}`);
    }
    // Next add should be rejected
    expect(() => mgr.add('overflow')).toThrow('filter critically saturated');
    mgr.destroy();
  });

  it('getMetrics returns counters after add and has', () => {
    const mgr = new BloomFilterManager({
      id: 'test-counters',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 50000,
      logger,
    });
    mgr.add('hello');
    mgr.add('world');
    mgr.has('hello');
    mgr.has('missing');
    const metrics = mgr.getMetrics();
    expect(metrics.counters.addSucceeded).toBe(2);
    expect(metrics.counters.addFailed).toBe(0);
    expect(metrics.counters.checks).toBe(2);
    expect(metrics.counters.hits).toBe(1);
    mgr.destroy();
  });

  it('add() throws after shutdown', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-shutdown',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 50000,
      logger,
    });
    await mgr.shutdown();
    expect(() => mgr.add('test')).toThrow('revoker is shutting down');
  });

  it('healthCheck reports saturated filter', () => {
    const mgr = new BloomFilterManager({
      id: 'test-health-sat',
      numItems: 10,
      fpRate: 0.01,
      rotateTime: 50000,
      logger,
    });
    const threshold = 10 * BloomFilterManager.MAX_SATURATION_RATIO;
    for (let i = 0; i <= threshold; i++) {
      mgr.add(`token-${i}`);
    }
    const health = mgr.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.checks.filter.healthy).toBe(false);
    expect(health.checks.filter.error).toContain('critically saturated');
    mgr.destroy();
  });

  it('resetAndRestore clears counters and insertions', async () => {
    manager.add('test');
    await manager.resetAndRestore();
    const metrics = manager.getMetrics();
    expect(metrics.counters.addSucceeded).toBe(0);
    await manager.resetAndClearData();
  });

  it('rotation continues when backupRotate fails', async () => {
    const mgr = new BloomFilterManager({
      id: 'test-rot-backup-fail',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 100,
      logger,
      backup: true,
      backupRatioTime: 2,
    });
    // Mock backupRotate to throw
    const backupRotateSpy = vi
      .spyOn(mgr.backupManager!, 'backupRotate')
      .mockRejectedValue(new Error('Disk full'));

    const currentBefore = mgr.current;
    // Wait for ONE rotation to fire (rotateTime=100) even though backupRotate rejects.
    await vi.waitFor(
      () => {
        expect(mgr.hasRotated).toBe(true);
        expect(mgr.current).not.toBe(currentBefore);
        expect(mgr.previous).not.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('continuing with memory-only rotation')
        );
      },
      { timeout: 2000, interval: 20 }
    );

    backupRotateSpy.mockRestore();
    mgr.destroy();
  });
});

describe('BloomFilterManager add() input safety', () => {
  let logger: MockLogger;
  let manager: BloomFilterManager;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new BloomFilterManager({
      id: 'test-input-safety',
      logger,
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 60000,
    });
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  it('add() rejects values containing line breaks or null bytes (WAL poisoning)', () => {
    expect(() => manager.add('evil\nsub-jti')).toThrow(
      'Value must not contain line breaks or null characters'
    );
    expect(() => manager.add('evil\r\nvalue')).toThrow(
      'Value must not contain line breaks or null characters'
    );
    expect(() => manager.add('evil\0value')).toThrow(
      'Value must not contain line breaks or null characters'
    );
  });

  it('add() rejects values longer than 4096 characters', () => {
    expect(() => manager.add('x'.repeat(4097))).toThrow(
      'Value exceeds maximum length of 4096 characters'
    );
    // Boundary: 4096 is accepted
    expect(() => manager.add('x'.repeat(4096))).not.toThrow();
  });

  it('add() after destroy() throws instead of silently dropping the revocation', () => {
    manager.destroy();
    expect(() => manager.add('some-token')).toThrow('Cannot add token: revoker is shutting down.');
  });
});

describe('BloomFilterManager backup restore resilience', () => {
  let logger: MockLogger;
  let backupDir: string;

  beforeEach(() => {
    logger = createMockLogger();
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoker-restore-test-'));
  });

  afterEach(() => {
    fs.rmSync(backupDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const baseConfig = (id: string) => ({
    id,
    numItems: 1000,
    fpRate: 0.01,
    rotateTime: 60000,
    backup: true as const,
  });

  it('starts with an empty filter when the blob is truncated (torn write)', () => {
    const id = 'test-torn-blob';
    // Write a blob whose size does not match the filter geometry
    fs.writeFileSync(path.join(backupDir, `current-${id}.blob`), Buffer.from([1, 2, 3]));

    const manager = new BloomFilterManager({ ...baseConfig(id), logger, backupDir });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('blob size does not match the configured filter')
    );
    // The instance must still be usable, with an empty filter
    expect(manager.has('anything')).toBe(false);
    expect(() => manager.add('new-token')).not.toThrow();
    expect(manager.has('new-token')).toBe(true);
    manager.destroy();
  });

  it('ignores a blob written for a different filter configuration', async () => {
    const id = 'test-geometry-mismatch';
    // Snapshot a 50k-item filter to disk
    const big = new BloomFilterManager({
      ...baseConfig(id),
      numItems: 50_000,
      logger: createMockLogger(),
      backupDir,
    });
    await big.backupManager!.backupLocal(big.current!);
    big.destroy();

    // Restart with a smaller configuration: the blob geometry no longer matches
    const manager = new BloomFilterManager({ ...baseConfig(id), logger, backupDir });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('blob size does not match the configured filter')
    );
    expect(manager.has('token-1')).toBe(false);
    manager.destroy();
  });
});
