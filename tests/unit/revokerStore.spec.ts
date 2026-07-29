import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import RevokerStore from '../../dist/revokerStore.js';
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

  it('RevokerStore - findInstance should log error and return undefined if bloomFilterManager is null', () => {
    revokerInstance.bloomFilterManager = null;
    RevokerStore.registerInstance(revokerInstance);
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Revoker instance or Bloom filter not found');
  });

  it('RevokerStore - findInstance should return undefined if instance is not found', () => {
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
  });

  it('RevokerStore - findInstance should log error if store is not initialized and return undefined', () => {
    RevokerStore.destroy();
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Revoker instance or Bloom filter not found');
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
});
