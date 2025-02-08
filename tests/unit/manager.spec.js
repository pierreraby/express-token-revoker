import { test } from '@japa/runner'
import sinon from 'sinon'
import fs from 'fs'
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js'


test.group('BloomFilterManager Constructor Validation', (group) => {

  let logger

  group.each.setup(() => {
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy(),
    }
  })

  group.each.teardown(() => {
      sinon.restore() // Restaure tous les stubs, fakes et mocks Sinon.
  })


  test('constructor throws error when numItems is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"numItems\" is required')
  })

  test('constructor throws error when numItems is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000.5,
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"numItems\" must be an integer')
  })

  test('constructor throws error for invalid numItems', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"numItems\" must be a positive number')
  })

  test('constructor throws error when fpRate is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"fpRate\" is required')
  })
  test('constructor throws error for invalid fpRate > 1', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 1.5,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"fpRate\" must be less than or equal to 1')
  })

  test('constructor throws error for invalid fpRate < 0', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: -0.5,
      rotateTime: 1000,
      logger
    })).toThrow('Invalid input: \"fpRate\" must be a positive number')
  })

  test('constructor throws error when rotateTime is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      logger
    })).toThrow('Invalid input: \"rotateTime\" is required')
  })

  test('constructor throws error when rotateTime is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000.5,
      logger
    })).toThrow('Invalid input: \"rotateTime\" must be an integer')
  })

  test('constructor throws error for invalid rotateTime', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 0,
      logger
    })).toThrow('Invalid input: \"rotateTime\" must be a positive number')
  })

  test('constructor throws error when backup is not a boolean', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      backup: 'true',
      logger
    })).toThrow('Invalid input: \"backup\" must be a boolean')
  })

  test('constructor throws error when backupTime is provided and backup is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      backup: false,
      backupTime: 500,
      logger
    })).toThrow('Invalid input: \"backupTime\" is not allowed')
  })

  test('constructor throws error when backupRatioTime is provided and backup is false', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      backup: false,
      backupRatioTime: 5,
      logger
    })).toThrow('Invalid input: \"backupRatioTime\" is not allowed')
  })


  test('constructor throws error when backupRatioTime is not a positive integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      backup: true,
      backupRatioTime: -5,
      logger
    })).toThrow('Invalid input: \"backupRatioTime\" must be a positive number')
  })

  test('constructor throws error when backupRatioTime is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      backup: true,
      backupRatioTime: 2.5,
      logger
    })).toThrow('Invalid input: \"backupRatioTime\" must be an integer')
  })

  // test('constructor throws error for backupRatioTime superior to rotateTime', ({expect}) => {
  //   expect(() => new BloomFilterManager({
  //     id: 'test',
  //     numItems: 1000,
  //     fpRate: 0.01,
  //     rotateTime: 1000,
  //     backup: true,
  //     backupRatioTime: 2000,
  //     logger
  //   })).toThrow('Invalid input: \"backupTime\" must be less than ref:rotateTime')
  // })

  test('constructor throws error if logger is not an object', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      logger: 'console'
    })).toThrow('Invalid input: \"logger\" must be of type object')
  });

  test('constructor throws error if logger is not an object with required methods', ({expect}) => {
    expect(() => new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      logger: { info: sinon.spy(), warn: sinon.spy() } // missing required methods
    })).toThrow('Invalid input: \"logger.error\" is required')
  });

  // test('constructor throws error if init method fails', ({expect}) => {
  //   sinon.stub(fs, 'mkdirSync').throws(new Error('Mocked write error'))
  //   expect(() => new BloomFilterManager({
  //     id: 'test',
  //     numItems: 1000,
  //     fpRate: 0.01,
  //     rotateTime: 1000,
  //     logger
  //   })).toThrow('Error accessing or creating backup directory: Mocked read dir error}')

  //   initStub.restore()
  // });

})

test.group('BloomFilterManager Add and Has', (group) => {
  let manager
  let logger

  group.each.setup(() => {
    logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy(),
    }
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 2000, // Temps de rotation court pour les tests
      logger,
      backup: true
    })
  })

  group.each.teardown(async () => {
    sinon.restore()
    await manager.resetAndClearData()
    manager.destroy()
  })

  test('add method adds a string value', ({expect}) => {
    manager.add('testValue')
    expect(manager.has('testValue')).toBe(true)
  })

  test('add adds a value to the current filter', ({ expect }) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('add throw an error if value is empty', ({ expect }) => {
    expect(() => manager.add('')).toThrow('Value must be a non-empty string')
    expect(manager.logger.error.called).toBe(false)
  })
   test('add throw an error if value is not a string', ({ expect }) => {
    expect(() => manager.add(123)).toThrow('Value must be a non-empty string')
    expect(manager.logger.error.called).toBe(false)
  })
  test('add throw an error when write to file failed', ({ expect }) => {
      sinon.stub(fs, 'appendFileSync').throws(new Error('Mocked write error'))
      expect(() => manager.add('test')).toThrow('Mocked write error')
  })

  test('has method returns true for added values', ({expect}) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('has returns false for a value not added', async ({ expect }) => {
    const value = 'nonExistent'
    await manager.resetAndClearData(); // 
    expect(manager.has(value)).toBe(false)
  })

  test('has returns true for a value added to the previous filter after rotation', async ({ expect }) => {
    const value = 'testValue'
    manager.add(value)
    await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
    expect(manager.has(value)).toBe(true)
  })

  test('has throws an error if value is empty', ({ expect }) => {
    expect(() => manager.has('')).toThrow('Value must be a non-empty string')
    expect(manager.logger.error.called).toBe(false)
  })

  test('has throws an error if value is not a string', ({ expect }) => {
    expect(() => manager.has(123)).toThrow('Value must be a non-empty string')
    expect(manager.logger.error.called).toBe(false)
  })

})

test.group('BloomFilterManager ResetAndRestore, ResetAndClearData and Destroy', (group) => {
  let manager
  let logger
    
  group.each.setup(() => {
    logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy(),
    }

    manager = new BloomFilterManager({
      id: 'test',
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 1000,
      logger,
      backup: true,
      backupRatioTime: 2
    })
  })

  group.each.teardown(() => {
    sinon.restore()
    manager.destroy()
  })

  test('resetAndRestore method clears the Bloom filters and restore', async ({expect}) => {
    manager.add('testValue')
    await manager.resetAndRestore()
    expect(manager.has('testValue')).toBe(true)
    await manager.resetAndClearData()
  })

  
  test('resetAndRestore resets timers and restore intervall', async ({ expect }) => {
    manager.add('testValue')
    await manager.resetAndRestore()
    expect(logger.debug.calledWith(`Rotation stopped for id: ${manager.id}`)).toBe(true)
    expect(logger.debug.calledWith(`Rotation stopped for id: ${manager.id}`)).toBe(true)
    expect(manager.rotationInterval).not.toBe(null)
    expect(manager.backupInterval).not.toBe(null)
    await manager.resetAndClearData()
  })

  test('resetAndRestore resets filters and restores backup temp files', async ({ expect }) => {
    sinon.resetHistory()
    manager.add('testValue')
    await manager.resetAndRestore()
    console.log(logger.debug.args)
    console.log(manager.id)
    expect(logger.debug.calledWith('Bloom filters reset')).toBe(true)
    expect(logger.debug.calledWith(`Elements restored from temp file for instance : ${manager.id}`)).toBe(true)
    expect(manager.has('testValue')).toBe(true)
    expect(manager.current).not.toBe(null)
    expect(manager.previous).toBe(null)
    await manager.resetAndClearData()
  })

  test('resetAndRestore reset filters and restore backup files after backup', async ({ expect }) => {
    sinon.resetHistory()
    manager.add('testValue')

    await new Promise(resolve => setTimeout(resolve, 600)) // await backup

    expect(logger.debug.calledWithMatch(sinon.match('Saved filter to:'))).toBe(true)
    expect(logger.debug.calledWith(`Temp file cleared for instance ${manager.id}`)).toBe(true)
    expect(logger.debug.calledWith('No previous filter to backup before first rotation')).toBe(true)
    manager.add('testValue2')

    await manager.resetAndRestore()

    expect(logger.debug.calledWith('Bloom filters reset')).toBe(true)
    expect(logger.debug.calledWith(`Restored current filter : id ${manager.id}`)).toBe(true)
    expect(logger.debug.calledWith(`Elements restored from temp file for instance : ${manager.id}`)).toBe(true)
    expect(manager.has('testValue')).toBe(true)
    expect(manager.has('testValue2')).toBe(true)
    await manager.resetAndClearData()
  })

  test('resetAndRestore reset filters and restore backup files after backup and rotation', async ({ expect }) => {
    manager.add('testValue')
    await new Promise(resolve => setTimeout(resolve, 600)) // await backup
    expect(logger.debug.calledWithMatch(sinon.match('Saved filter to:'))).toBe(true)
    expect(logger.debug.calledWith(`Temp file cleared for instance ${manager.id}`)).toBe(true)
    expect(logger.debug.calledWith('No previous filter to backup before first rotation')).toBe(true)
    manager.add('testValue2')
    await new Promise(resolve => setTimeout(resolve, 600)) // await rotation
    expect(logger.debug.calledWith('Rotating Bloom filters...')).toBe(true) 
    manager.add('testValue3')
    await manager.resetAndRestore()
    expect(manager.has('testValue')).toBe(true)
    expect(manager.has('testValue2')).toBe(true)
    expect(manager.has('testValue3')).toBe(true)
    await manager.resetAndClearData()
  })


  test('resetAndClearData method clears the Bloom filters and clear data', async ({expect}) => {
    manager.add('testValue')
    await manager.resetAndClearData();
    expect(manager.has('testValue')).toBe(false)
  })

  test('resetAndClearData resets filters and deletes backup files', async ({ expect }) => {
    manager.add('testValue')
    await new Promise(resolve => setTimeout(resolve, 600)) // await backup
    expect(logger.debug.calledWithMatch(sinon.match('Saved filter to:'))).toBe(true)
    expect(logger.debug.calledWith(`Temp file cleared for instance ${manager.id}`)).toBe(true)
    expect(logger.debug.calledWith('No previous filter to backup before first rotation')).toBe(true)
    manager.add('testValue2')
    await new Promise(resolve => setTimeout(resolve, 600)) // await rotation
    expect(logger.debug.calledWith('Rotating Bloom filters...')).toBe(true) 
    manager.add('testValue3')
    await manager.resetAndClearData()
    expect(manager.has('testValue')).toBe(false)
    expect(manager.has('testValue2')).toBe(false)
    expect(manager.has('testValue3')).toBe(false)
  })

  test('resetAndClearData sets hasRotated to false', async ({ expect }) => {
    await manager.resetAndClearData()
    expect(manager.hasRotated).toBe(false)
  })

  test('destroy method properly cleans up the manager', async ({ expect }) => {
    const clearIntervalSpy = sinon.spy(global, 'clearInterval')
    manager.destroy()
    expect(manager.previous).toBeNull()
    expect(manager.current).toBeNull()
    expect(manager.rotationInterval).toBeNull()
    expect(manager.backupInterval).toBeNull()
    expect(clearIntervalSpy.called).toBe(true)
    expect(clearIntervalSpy.calledTwice).toBe(true)
    clearIntervalSpy.restore()
  })


})

test.group('BloomFilterManager Rotation', (group) => {
  let manager
  let logger

  group.setup(() => {
      logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy()
      }
      manager = new BloomFilterManager({
        id: 'test',
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 500, // Temps de rotation court pour les tests
        logger
      })
  })

  group.teardown(async () => {
    sinon.restore()
    await manager.resetAndClearData()
    manager.destroy()
  })

  test('rotate switches current to previous and creates a new current', async ({ expect }) => {
    const initialCurrent = manager.current
    await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
    expect(manager.previous).toBe(initialCurrent)
    expect(manager.current).not.toBe(initialCurrent)
  })

  test('rotate set hasRotated to true', async ({ expect }) => {
      await manager.resetAndClearData()
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
      expect(manager.hasRotated).toBe(true)
      manager.hasRotated = false
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
      expect(manager.hasRotated).toBe(true)
  })

  test('rotate is called after rotateTime', async ({ expect }) => {
      const initialCurrent = manager.current
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation + marge
      expect(manager.previous).toBe(initialCurrent)
      expect(manager.current).not.toBe(initialCurrent)
  })

  test('filters rotate correctly after rotateTime', async ({expect}) => {
    manager.add('value1')
    expect(manager.has('value1')).toBe(true)
    // Wait for rotation to occur
    await new Promise((resolve) => setTimeout(resolve, 600)) // wait slightly more than rotateTime
    manager.add('value2')
    expect(manager.has('value1')).toBe(true)
    expect(manager.has('value2')).toBe(true)
  })

})

test.group('BloomFilterManager metrics', (group) => {
  let manager;
  let logger;
  const NUMITEMS = 10000;

  group.each.setup(() => {
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }
    manager = new BloomFilterManager({
      id: 'test',
      numItems: 10000,
      fpRate: 0.0001,
      rotateTime: 500, // Temps de rotation court pour les tests
      logger
    })
  })

  group.each.teardown(async () => {
    sinon.restore()
    await manager.resetAndClearData()
    manager.destroy()
  })

  test('getMetrics returns correct values after init', async ({expect}) => {
    logger.info.resetHistory()
    const metrics = manager.getMetrics()
    expect(metrics.estimatedMetrics.currentCount).toBe(-0);
    expect(metrics.estimatedMetrics.currentFpRate).toBe(0);
    expect(metrics.estimatedMetrics.previousCount).toBe(0);
    expect(metrics.estimatedMetrics.previousFpRate).toBe(0);
    expect(metrics.configuration.numItems).toBe(NUMITEMS);
    expect(metrics.configuration.fpRate).toBe(0.0001);
    expect(metrics.configuration.rotateTime).toBe(500);
    expect(metrics.configuration.backupEnabled).toBe(false);
    expect(metrics.configuration.backupTime).toBe(undefined);
  })

  test('getEstimatedMetricx returns correct values after filling current filter', async ({expect}) => {
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString())
    }
    const metrics = manager.getMetrics().estimatedMetrics;
    expect(metrics.currentCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.currentCount).toBeLessThan(NUMITEMS + 50);

    expect(metrics.currentFpRate).toBeCloseTo(0.0001, 4)
    expect(metrics.previousCount).toBe(0)
    expect(metrics.previousFpRate).toBe(0)
  })

  test('getEstimatedMetrics returns correct values after rotation', async ({expect}) => {
    // Fill current filter
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString())
    }
    await new Promise(resolve => setTimeout(resolve, 600)) // wait for rotation
    // Fill new current filter
    for (let i = 0; i < NUMITEMS; i++) {
      manager.add(i.toString())
    }
    const metrics = manager.getMetrics().estimatedMetrics;
    expect(metrics.currentCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.currentCount).toBeLessThan(NUMITEMS + 50);
    expect(metrics.currentFpRate).toBeCloseTo(0.0001, 4)
    expect(metrics.previousCount).toBeGreaterThan(NUMITEMS - 50);
    expect(metrics.previousCount).toBeLessThan(NUMITEMS + 50);
    expect(metrics.previousFpRate).toBeCloseTo(0.0001, 4)
  })
})

// private methods
// test.group('BloomFilterManager Error Handling', (group) => {
//   let manager
//   let createBloomFilterStub
//   let consoleErrorSpy
//   let addStub
//   let testStubCurrent

//   group.setup(() => {
//     manager = new BloomFilterManager({
//       numItems: 1000,
//       fpRate: 0.01,
//       rotateTime: 1000,
//       logger: console
//     })
//     createBloomFilterStub = sinon.stub(manager, '_createBloomFilter').throws(new Error('Test Error'))
//     consoleErrorSpy = sinon.spy(console, 'error')
//     addStub = sinon.stub(manager.current, 'add').throws(new Error('Add Error'))
//   })

//   group.teardown(() => {
//     createBloomFilterStub.restore()
//     consoleErrorSpy.restore()
//     addStub.restore()
//     manager.destroy()
//   })

//   test('rotate method logs error when _createBloomFilter throws', ({ expect }) => {
//     manager.rotate()
//     expect(consoleErrorSpy.calledOnce).toBe(true)
//     expect(consoleErrorSpy.firstCall.args[0]).toBe('Error rotating Bloom filters:')
//     expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
//   })

//   test('add method logs error when current.add throws', ({ expect }) => {
//     consoleErrorSpy.resetHistory()
//     const value = 'testValue'
//     expect(() => manager.add(value)).toThrow('Add Error')
//     expect(consoleErrorSpy.calledOnce).toBe(true)
//     expect(consoleErrorSpy.firstCall.args[0]).toBe('Error adding value to Bloom filter:')
//     expect(consoleErrorSpy.firstCall.args[1].message).toBe('Add Error')
//   })

//   test('reset method logs error when _createBloomFilter throws', ({ expect }) => {
//     consoleErrorSpy.resetHistory()
//     createBloomFilterStub.throws(new Error('Reset Error'))
//     expect(() => manager.reset()).toThrow('Reset Error')
//     expect(consoleErrorSpy.calledOnce).toBe(true)
//     expect(consoleErrorSpy.firstCall.args[0]).toBe('Error resetting Bloom filters:')
//     expect(consoleErrorSpy.firstCall.args[1].message).toBe('Reset Error')
//   })

//   test('has method logs error when current.test throws', ({ expect }) => {
//     consoleErrorSpy.resetHistory()
//     const value = 'testValue'
//     testStubCurrent = sinon.stub(manager.current, 'test').throws(new Error('Test Error'))
//     const result = manager.has(value)
    
//     expect(result).toBe(false)
//     expect(consoleErrorSpy.calledOnce).toBe(true)
//     expect(consoleErrorSpy.firstCall.args[0]).toBe('Error in has:')
//     expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
//   })

//   test('backupLocal method logs error when filterName is invalid', ({ expect }) => {
//     const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.current = null
//     manager.logger = loggerStub 
//     manager.backupLocal('invalid')

//     expect(writeFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     expect(loggerStub.error.calledWith("Backup failed: filterName parameter must be either 'current', 'previous', or 'all'"))
//       .toBe(true)
//     writeFileSyncStub.restore()
//     consoleErrorSpy.resetHistory()
//   })

//   test('backupLocal previous method should not throw error when previousDone is false', ({ expect }) => {
//     const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.previousDone = false
//     manager.previous = null
//     manager.logger = loggerStub 
//     manager.backupLocal('previous')

//     expect(writeFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.calledOnce).toBe(true)
//     expect(loggerStub.debug.calledWith('No previous filter to backup.')).toBe(true)
//     writeFileSyncStub.restore()
//   })

//   test('backupLocal current throw error if current filter not exist', ({ expect }) => {
//     const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.current = null
//     manager.logger = loggerStub
//     manager.instanceId = '123'
//     manager.backupLocal('current')

//     expect(writeFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     expect(loggerStub.error.calledWith(`Backup failed: There is no current filter to backup on instance : ${manager.instanceId}`)).toBe(true)
//     writeFileSyncStub.restore()
//   })

//   test('backupLocal previous throw error if previous filter not exist and previouDone is true', ({ expect }) => {
//     const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.previous = null
//     manager.previousDone = true
//     manager.logger = loggerStub 
//     manager.instanceId = '123'
//     manager.backupLocal('previous')

//     expect(writeFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     expect(loggerStub.error.calledWith(`Backup failed: There is no previous filter to backup on instance : ${manager.instanceId}`)).toBe(true)
//     writeFileSyncStub.restore()
//   })

//   test('backupLocal all throw error if current filter not exist', ({ expect }) => {
//     const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.current = null
//     manager.logger = loggerStub
//     manager.instanceId = '123'
//     manager.backupLocal('all')

//     expect(writeFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     expect(loggerStub.error.calledWith(`Backup failed: There is no current filter to backup on instance : ${manager.instanceId}`)).toBe(true)
//     writeFileSyncStub.restore()
//   })

//   test('RestoreLocal throw error if filterName is invalid', ({ expect }) => {
//     const readFileSyncStub = sinon.stub(fs, 'readFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

//     manager.logger = loggerStub
//     manager.instanceId = '123'
//     manager.restoreLocal('invalid')

//     expect(readFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     expect(loggerStub.error.calledWith("Restore failed: filterName parameter must be either 'current', 'previous', or 'all'"))
//       .toBe(true)
//     readFileSyncStub.restore()
//   })

//   test('RestoreLocal throw error if current filter not exist', ({ expect }) => {
//     const readFileSyncStub = sinon.stub(fs, 'readFileSync')
//     const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
//     consoleErrorSpy.resetHistory()

//     manager.current = null
//     manager.logger = loggerStub
//     manager.instanceId = '123'
//     manager.restoreLocal('current')

//     expect(readFileSyncStub.notCalled).toBe(true)
//     expect(loggerStub.debug.notCalled).toBe(true)
//     console.log(loggerStub.error.args)
//     expect(loggerStub.error.called).toBe(true)
//     //expect(loggerStub.error.calledWith(`Restore failed: No current instance for determine k parameter for instance : id ${manager.instanceId}`).toBe(true))
//     readFileSyncStub.restore()
//   })
// })