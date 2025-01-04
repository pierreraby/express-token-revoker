import { test } from '@japa/runner'
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'
import { Revoker } from '../dist/index.js'
import sinon from 'sinon'
import e from 'express'

test.group('BloomFilterManager Constructor Validation', () => {
  test('constructor throws error when numItems is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when numItems is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000.5,
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error for invalid numItems', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when fpRate is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      rotateTime: 1000,
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })
  test('constructor throws error for invalid fpRate', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 1.5,
      rotateTime: 1000,
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })

  test('constructor throws error when rotateTime is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error when rotateTime is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000.5,
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error for invalid rotateTime', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 0,
    })).toThrow('rotateTime must be a positive integer.')
  })
})

test.group('BloomFilterManager Functional Tests', (group) => {
  let manager
  let clearIntervalSpy

  group.setup(() => {
    clearIntervalSpy = sinon.spy(global, 'clearInterval')
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000, // 1 second for testing
    })
  })

  group.teardown(() => {
    manager.destroy()
    clearIntervalSpy.restore()
  })

  test('filters rotate correctly after rotateTime', async ({expect}) => {
    manager.add('value1')
    expect(manager.has('value1')).toBe(true)
    // Wait for rotation to occur
    await new Promise((resolve) => setTimeout(resolve, 1100)) // wait slightly more than rotateTime
    manager.add('value2')
    expect(manager.has('value1')).toBe(true)
    expect(manager.has('value2')).toBe(true)
  })

  test('add method adds a string value', ({expect}) => {
    manager.add('testValue')
    expect(manager.has('testValue')).toBe(true)
  })

  test('add method throws error when adding non-string', ({expect}) => {
    expect(() => manager.add(123)).toThrow('Value must be a string.')
  })

  test('has method returns true for added values', ({expect}) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('has method returns false for non-added values', ({expect}) => {
    expect(manager.has('nonExistent')).toBe(false)
  })

  test('reset method clears the Bloom filters', async ({expect}) => {
    manager.add('testValue')
    await manager.reset()
    expect(manager.has('testValue')).toBe(false)
  })

  test('destroy method properly cleans up the manager', ({ expect }) => {
    manager.destroy()
    expect(manager.previous).toBeNull()
    expect(manager.current).toBeNull()
    expect(manager.next).toBeNull()
    expect(manager.rotationInterval).toBeNull()
    expect(clearIntervalSpy.calledOnce).toBe(true)
  })

  test('stopRotation method stops the rotation process', ({ expect }) => {
    manager.stopRotation()
    expect(manager.rotationInterval).toBeNull()
    expect(clearIntervalSpy.calledOnce).toBe(true)
  })
})

test.group('Revoker Class Tests', (group) => {
  let destroySpy

  group.teardown(() => {
    
  })
  test('constructor throws error when neither claimsToCheck nor opaqueHeader is provided', ({ expect }) => {
    destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
    expect(() => new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000
    })).toThrow('claimsToCheck or opaqueHeader must be provided')
    expect(destroySpy.called).toBe(true)
    destroySpy.restore()
  })

  test('constructor initializes BloomFilterManager with correct options', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    }
    const instance = new Revoker(config)
    expect(instance.bloomFilterManager).toBeInstanceOf(BloomFilterManager)
    expect(instance.bloomFilterManager.numItems).toBe(config.numItems)
    expect(instance.bloomFilterManager.fpRate).toBe(config.fpRate)
    expect(instance.bloomFilterManager.rotateTime).toBe(config.rotateTime)
    expect(instance.bloomFilterManager.current).toBeDefined()
    expect(instance.bloomFilterManager.next).toBeDefined()
    expect(instance.bloomFilterManager.previous).toBeNull()
    expect(instance.bloomFilterManager.rotationInterval).toBeDefined()
    expect(instance.bloomFilterManager.mutex).toBeDefined()
    instance.bloomFilterManager.destroy()
  })

  test('constructor initializes middleware with claimsToCheck', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2']
    }
    const instance = new Revoker(config)
    const middleware = instance.getMiddleware()
    expect(middleware).toBeDefined()
    expect(middleware).toBeInstanceOf(Function)
    expect(middleware.length).toBe(3)
    instance.bloomFilterManager.destroy()
  })

  test('constructor initializes middleware with opaqueHeader', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization'
    }
    const instance = new Revoker(config)
    const middleware = instance.getMiddleware()
    expect(middleware).toBeDefined()
    expect(middleware).toBeInstanceOf(Function)
    expect(middleware.length).toBe(3)
    instance.bloomFilterManager.destroy()
  })
})