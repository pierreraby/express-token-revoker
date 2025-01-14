import { test } from '@japa/runner'
import sinon from 'sinon'
import fs from 'fs'
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js'
import { group } from 'console'


test.group('BloomFilterManager Constructor Validation', (group) => {

  let logger

  group.each.setup(() => {
    logger = {
          info: sinon.spy(),
          warn: sinon.spy(),
          debug: sinon.spy(),
          error: sinon.spy()
    }
  })

  group.each.teardown(() => {
      sinon.restore() // Restaure tous les stubs, fakes et mocks Sinon.
  })


  test('constructor throws error when numItems is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when numItems is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000.5,
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error for invalid numItems', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })).toThrow('numItems must be a positive integer.')
  })

  test('constructor throws error when fpRate is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      rotateTime: 1000,
      logger
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })
  test('constructor throws error for invalid fpRate', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 1.5,
      rotateTime: 1000,
      logger
    })).toThrow('fpRate must be a number between 0 and 1 (exclusive).')
  })

  test('constructor throws error when rotateTime is not provided', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      logger
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error when rotateTime is not an integer', ({ expect }) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000.5,
      logger
    })).toThrow('rotateTime must be a positive integer.')
  })

  test('constructor throws error for invalid rotateTime', ({expect}) => {
    expect(() => new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 0,
      logger
    })).toThrow('rotateTime must be a positive integer.')
  })
})

test.group('BloomFilterManager Add and Has', (group) => {
  let manager
  let logger

  group.each.setup(() => {
    logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy()
    }
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 2000, // Temps de rotation court pour les tests
      logger,
      backupPeriod: 1000
    })
  })

  group.each.teardown(() => {
    sinon.restore()
    manager.destroy()
  })

  test('add adds a value to the current filter', ({ expect }) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('has returns false for a value not added', async ({ expect }) => {
    const value = 'testValue'
    await manager.resetAndClearData(); // 
    expect(manager.has(value)).toBe(false)
  })

  test('has returns true for a value added to the previous filter after rotation', async ({ expect }) => {
    const value = 'testValue'
    manager.add(value)
    await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
    expect(manager.has(value)).toBe(true)
  })
   test('add throw an error if value is empty', ({ expect }) => {
    expect(() => manager.add('')).toThrow('Value must be a string')
    expect(manager.logger.error.called).toBe(false)
  })
   test('add throw an error if value is not a string', ({ expect }) => {
    expect(() => manager.add(123)).toThrow('Value must be a string')
    expect(manager.logger.error.called).toBe(false)
  })
  test('add throw an error when write to file failed', ({ expect }) => {
      sinon.stub(fs, 'appendFileSync').throws(new Error('Mocked write error'))
      expect(() => manager.add('test')).toThrow('Mocked write error')
      expect(manager.logger.error.calledWith('Error adding value to Bloom filter:')).toBe(true)
  })
})

test.group('BloomFilterManager Reset and ResetAndClearData', (group) => {
  let manager
  let logger
  let deleteBackupFileStub
    
  group.each.setup(() => {
    logger = {
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
        error: sinon.spy()
    }
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      logger
    })
    deleteBackupFileStub = sinon.stub(manager, '#deleteBackupFile').resolves()
  })

  group.each.teardown(() => {
    sinon.restore()
    manager.destroy()
  })


  test('resetAndClearData resets filters and deletes backup files', async ({ expect }) => {
    manager.add('testValue')
    await manager.resetAndClearData()
    expect(manager.has('testValue')).toBe(false)
    expect(deleteBackupFileStub.calledThrice).toBe(true) // called for current, previous, and temp
  })
  test('resetAndClearData re-init the manager', async ({ expect }) => {
      const initStub = sinon.stub(manager, '#init')
      await manager.resetAndClearData()
      expect(initStub.calledOnce).toBe(true)
  })
  test('reset throw error if createBloomFilter throw error', async ({ expect }) => {
      sinon.stub(manager, '#createBloomFilter').throws(new Error('Mocked create error'))
      await expect(manager.reset()).rejects.toThrow('Mocked create error')
      expect(manager.logger.error.calledWith('Error resetting Bloom filters:')).toBe(true)
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
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 500, // Temps de rotation court pour les tests
          logger
      })
  })

  group.teardown(() => {
    sinon.restore()
    manager.destroy()
  })

  test('rotate switches current to previous and creates a new current', async ({ expect }) => {
    const initialCurrent = manager.current
    await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
    expect(manager.previous).toBe(initialCurrent)
    expect(manager.current).not.toBe(initialCurrent)
  })

  test('rotate set previousDone to true', async ({ expect }) => {
      await manager.reset()
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
      expect(manager.previousDone).toBe(true)
      manager.previousDone = false
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation
      expect(manager.previousDone).toBe(true)
  })

  test('rotate is called after rotateTime', async ({ expect }) => {
      const initialCurrent = manager.current
      await new Promise(resolve => setTimeout(resolve, 600)) // Attendre la rotation + marge
      expect(manager.previous).toBe(initialCurrent)
      expect(manager.current).not.toBe(initialCurrent)
  })
  test('rotate throw error if createBloomFilter throw error', async ({ expect }) => {
      sinon.stub(manager, '#createBloomFilter').throws(new Error('Mocked create error'))
      await expect(manager.rotate()).rejects.toThrow('Mocked create error')
      expect(manager.logger.error.calledWith('Error rotating Bloom filters:')).toBe(true)
  })
})

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