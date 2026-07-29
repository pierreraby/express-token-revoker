import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RevokerStore from '../../src/revokerStore.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

describe('RevokerStore validation', () => {
  let logger: MockLogger;
  let revokerInstance: any;

  beforeEach(() => {
    // Reset the store if needed
    try {
      RevokerStore.destroy();
    } catch (_) {
      /* best-effort reset */
    }
    RevokerStore.init();
    logger = createMockLogger();
    revokerInstance = {
      id: 'test-revoker-1',
      logger,
      bloomFilterManager: {}, // non-null object
    };
  });

  afterEach(() => {
    try {
      RevokerStore.destroy();
    } catch (_) {
      /* best-effort reset */
    }
  });

  it('RevokerStore - Init throws error if already initialized', () => {
    expect(() => RevokerStore.init()).toThrow('Revoker instances map is already initialized');
  });

  it('RevokerStore - RegisterInstance register and log registration', () => {
    RevokerStore.registerInstance(revokerInstance);
    expect(RevokerStore.listInstances()).toContain(revokerInstance.id);
    expect(logger.info).toHaveBeenCalledWith(`Revoker instance ${revokerInstance.id} registered`);
  });

  it('RevokerStore - RegisterInstance throws error if store is not initialized', () => {
    RevokerStore.destroy();
    expect(() => RevokerStore.registerInstance(revokerInstance)).toThrow(
      'Revoker instances map is not initialized'
    );
  });

  it('RevokerStore - unregisterInstance should unregister a revoker instance', () => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.unregisterInstance(revokerInstance.id);
    expect(RevokerStore.listInstances()).not.toContain(revokerInstance.id);
  });

  it('RevokerStore - unregisterInstance throws error if store is not initialized', () => {
    RevokerStore.destroy();
    expect(() => RevokerStore.unregisterInstance(revokerInstance.id)).toThrow(
      'Revoker instances map is not initialized'
    );
  });

  it('RevokerStore - findInstance should return the instance if present with non-null bloomFilterManager', () => {
    RevokerStore.registerInstance(revokerInstance);
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBe(revokerInstance);
  });

  it('RevokerStore - findInstance should log at debug level and return undefined if bloomFilterManager is null', () => {
    revokerInstance.bloomFilterManager = null;
    RevokerStore.registerInstance(revokerInstance);
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith('Revoker instance or Bloom filter not found');
  });

  it('RevokerStore - findInstance should return undefined if instance is not found', () => {
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
  });

  it('RevokerStore - findInstance should log at debug level if store is not initialized and return undefined', () => {
    RevokerStore.destroy();
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith('Revoker instance or Bloom filter not found');
  });

  it('RevokerStore - listInstances should list all registered instance ids', () => {
    RevokerStore.registerInstance(revokerInstance);
    const ids = RevokerStore.listInstances();
    expect(ids).toEqual([revokerInstance.id]);
  });

  it('RevokerStore - listInstances should throw error if store is not initialized', () => {
    RevokerStore.destroy();
    expect(() => RevokerStore.listInstances()).toThrow('Revoker instances map is not initialized');
  });

  it('RevokerStore - destroy should clear the store and set map to null', () => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.destroy();
    expect(() => RevokerStore.isEmpty()).toThrow('Revoker instances map is not initialized');
  });

  it('RevokerStore - destroy should throw error if destroy is called when store is not initialized', () => {
    RevokerStore.destroy();
    expect(() => RevokerStore.destroy()).toThrow('Revoker instances map is not initialized');
  });

  it('RevokerStore - isEmpty should return true if store is empty', () => {
    expect(RevokerStore.isEmpty()).toBe(true);
  });

  it('RevokerStore - isEmpty should return false if store has instances', () => {
    RevokerStore.registerInstance(revokerInstance);
    expect(RevokerStore.isEmpty()).toBe(false);
  });

  it('RevokerStore - isEmpty should throw error if store is not initialized', () => {
    RevokerStore.destroy();
    expect(() => RevokerStore.isEmpty()).toThrow('Revoker instances map is not initialized');
  });

  it('RevokerStore - is frozen (no mutations after creation)', () => {
    expect(Object.isFrozen(RevokerStore)).toBe(true);
    expect(() => {
      (RevokerStore as any).extraMethod = vi.fn();
    }).toThrow();
  });

  it('RevokerStore - multiple instances share the same store', () => {
    const instance2: any = {
      id: 'test-revoker-2',
      logger: createMockLogger(),
      bloomFilterManager: {}, // non-null object
    };
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.registerInstance(instance2);
    expect(RevokerStore.listInstances()).toEqual([revokerInstance.id, instance2.id]);
    RevokerStore.unregisterInstance(revokerInstance.id);
    expect(RevokerStore.listInstances()).toEqual([instance2.id]);
    expect(RevokerStore.isEmpty()).toBe(false);
  });

  it('RevokerStore - init after destroy reinitializes cleanly', () => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.destroy();
    RevokerStore.init();
    expect(RevokerStore.isEmpty()).toBe(true);
    expect(RevokerStore.listInstances()).toEqual([]);
  });

  it('RevokerStore - destroy with instances clears all', () => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.destroy();
    expect(() => RevokerStore.listInstances()).toThrow('Revoker instances map is not initialized');
  });
});
