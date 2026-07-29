import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js';
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
        })
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
        })
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
    ).toThrow('Invalid input: "fpRate" must be less than or equal to 1');
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
        })
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
          backupTime: 500 as any,
          logger,
        })
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
    await new Promise((resolve) => setTimeout(resolve, 600)); // Attendre la rotation
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
    expect(manager.backupInterval).not.toBe(null);
    await manager.resetAndClearData();
  });

  it('resetAndRestore resets filters and restores backup temp files', async () => {
    vi.clearAllMocks();
    manager.add('testValue');
    await manager.resetAndRestore();
    console.log(logger.debug.mock.calls);
    console.log(manager.id);
    expect(logger.debug).toHaveBeenCalledWith('Bloom filters reset');
    expect(logger.debug).toHaveBeenCalledWith(`Elements restored from temp file for instance : ${manager.id}`);
    expect(manager.has('testValue')).toBe(true);
    expect(manager.current).not.toBe(null);
    expect(manager.previous).toBe(null);
    await manager.resetAndClearData();
  });

  it('resetAndRestore reset filters and restore backup files after backup', async () => {
    vi.clearAllMocks();
    manager.add('testValue');

    await new Promise((resolve) => setTimeout(resolve, 600)); // await backup

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Saved filter to:'));
    expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
    // NOTE: assertion originale probablement no-op ou message inexistant — conservée
    expect(logger.debug).toHaveBeenCalledWith('No previous filter to backup before first rotation');
    manager.add('testValue2');

    await manager.resetAndRestore();

    expect(logger.debug).toHaveBeenCalledWith('Bloom filters reset');
    expect(logger.debug).toHaveBeenCalledWith(`Restored current filter : id ${manager.id}`);
    expect(logger.debug).toHaveBeenCalledWith(`Elements restored from temp file for instance : ${manager.id}`);
    expect(manager.has('testValue')).toBe(true);
    expect(manager.has('testValue2')).toBe(true);
    await manager.resetAndClearData();
  });

  it('resetAndRestore reset filters and restore backup files after backup and rotation', async () => {
    manager.add('testValue');
    await new Promise((resolve) => setTimeout(resolve, 600)); // await backup
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Saved filter to:'));
    expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
    expect(logger.debug).toHaveBeenCalledWith('No previous filter to backup before first rotation');
    manager.add('testValue2');
    await new Promise((resolve) => setTimeout(resolve, 600)); // await rotation
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
    await new Promise((resolve) => setTimeout(resolve, 600)); // await backup
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Saved filter to:'));
    expect(logger.debug).toHaveBeenCalledWith(`Temp file cleared for instance ${manager.id}`);
    expect(logger.debug).toHaveBeenCalledWith('No previous filter to backup before first rotation');
    manager.add('testValue2');
    await new Promise((resolve) => setTimeout(resolve, 600)); // await rotation
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
    expect(manager.backupInterval).toBeNull();
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
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(manager.previous).toBe(initialCurrent);
    expect(manager.current).not.toBe(initialCurrent);
  });

  it('rotate set hasRotated to true', async () => {
    await manager.resetAndClearData();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(manager.hasRotated).toBe(true);
    manager.hasRotated = false;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(manager.hasRotated).toBe(true);
  });

  it('rotate is called after rotateTime', async () => {
    const initialCurrent = manager.current;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(manager.previous).toBe(initialCurrent);
    expect(manager.current).not.toBe(initialCurrent);
  });

  it('filters rotate correctly after rotateTime', async () => {
    manager.add('value1');
    expect(manager.has('value1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
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
    await new Promise((resolve) => setTimeout(resolve, 600));
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
