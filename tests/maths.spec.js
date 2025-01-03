import { test } from '@japa/runner'
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'

test.group('BloomFilterManager Tests', (group) => {
  let manager

  group.each.setup(async () => {
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000, // 1 second for testing
    })
  })

  group.each.teardown(async () => {
    manager.stopRotation()
    manager.destroy()
  })

  test('constructor throws error for invalid numItems', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
    })).toThrow('numItems must be a positive number.')
  })
  test('constructor throws error for invalid fpRate', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 1.5,
      rotateTime: 1000,
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })

  test('constructor throws error for invalid rotateTime', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 0,
    })).toThrow('rotateTime must be a positive number.')
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

  test('filters rotate correctly after rotateTime', async ({expect}) => {
    manager.add('value1')
    expect(manager.has('value1')).toBe(true)
    // Wait for rotation to occur
    await new Promise((resolve) => setTimeout(resolve, 1100)) // wait slightly more than rotateTime
    manager.add('value2')
    expect(manager.has('value1')).toBe(true)
    expect(manager.has('value2')).toBe(true)
  })
})