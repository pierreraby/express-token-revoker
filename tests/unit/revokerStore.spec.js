import RevokerStore from '#dist/revokerStore.js';
import sinon from 'sinon';
import { test } from '@japa/runner'

test.group('RevokerStore validation', (group) => {
  let logger;
  let revokerInstance;

  group.each.setup(() => {
    // Reset the store if needed
    try {
      RevokerStore.destroy();
    } catch (_) {}
    RevokerStore.init();
    logger = {
      info: sinon.spy(),
      error: sinon.spy()
    };
    revokerInstance = {
      id: 'test-revoker-1',
      logger,
      bloomFilterManager: {} // non-null object
    };
  });

  group.each.teardown(() => {
    try {
      RevokerStore.destroy();
    } catch (_) {}
  });

  test('RevokerStore - Init throws error if already initialized', ({ expect }) => {
      expect(() => RevokerStore.init()).toThrow(Error, 'Revoker instances map is already initialized');
  });

  test('RevokerStore - RegisterInstance register and log registration', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    expect(RevokerStore.listInstances()).toContain(revokerInstance.id);
    sinon.assert.calledWith(logger.info, `Revoker instance ${revokerInstance.id} registered`);
  });

  test('RevokerStore - RegisterInstance throws error if store is not initialized', ({ expect }) => {
    RevokerStore.destroy();
    expect(() => RevokerStore.registerInstance(revokerInstance)).toThrow(Error, 'Revoker instances map is not initialized');
  });


  test('RevokerStore - unregisterInstance should unregister a revoker instance', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.unregisterInstance(revokerInstance.id);
    expect(RevokerStore.listInstances()).not.toContain(revokerInstance.id);
  });

  test('RevokerStore - unregisterInstance throws error if store is not initialized', ({ expect }) => {
    RevokerStore.destroy();
    expect(() => RevokerStore.unregisterInstance(revokerInstance.id)).toThrow(Error, 'Revoker instances map is not initialized');
  });

  test('RevokerStore - findInstance should return the instance if present with non-null bloomFilterManager', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBe(revokerInstance);
  });

  test('RevokerStore - findInstance should log error and return undefined if bloomFilterManager is null', ({ expect }) => {
    revokerInstance.bloomFilterManager = null;
    RevokerStore.registerInstance(revokerInstance);
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    sinon.assert.calledWith(logger.error, 'Revoker instance or Bloom filter not found');
  });

  test('RevokerStore - findInstance should return undefined if instance is not found', ({ expect }) => {
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
  });

  test('RevokerStore - findInstance should log error if store is not initialized and return undefined', ({ expect }) => {
    RevokerStore.destroy();
    const found = RevokerStore.findInstance(revokerInstance.id, logger);
    expect(found).toBeUndefined();
    sinon.assert.calledWith(logger.error, 'Revoker instance or Bloom filter not found');
  });

  test('RevokerStore - listInstances should list all registered instance ids', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    const ids = RevokerStore.listInstances();
    expect(ids).toEqual([revokerInstance.id]);
  });

  test('RevokerStore - listInstances should throw error if store is not initialized', ({ expect }) => {
    RevokerStore.destroy();
    expect(() => RevokerStore.listInstances()).toThrow(Error, 'Revoker instances map is not initialized');
  });

  test('RevokerStore - destroy should clear the store and set map to null', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    RevokerStore.destroy();
    expect(() => RevokerStore.isEmpty()).toThrow(Error, 'Revoker instances map is not initialized');
  });

  test('RevokerStore - destroy should throw error if destroy is called when store is not initialized', ({ expect }) => {
    RevokerStore.destroy();
    expect(() => RevokerStore.destroy()).toThrow(Error, 'Revoker instances map is not initialized');
  });

  test('RevokerStore - isEmpty should return true if store is empty', ({ expect }) => {
    expect(RevokerStore.isEmpty()).toBe(true);
  });

  test('RevokerStore - isEmpty should return false if store has instances', ({ expect }) => {
    RevokerStore.registerInstance(revokerInstance);
    expect(RevokerStore.isEmpty()).toBe(false);
  });

  test('RevokerStore - isEmpty should throw error if store is not initialized', ({ expect }) => {
    RevokerStore.destroy();
    expect(() => RevokerStore.isEmpty()).toThrow(Error, 'Revoker instances map is not initialized');
  });

});