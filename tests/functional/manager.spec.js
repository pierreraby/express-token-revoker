import { test } from '@japa/runner'
import sinon from 'sinon'
import { BloomFilterManager } from "../../dist/Bloom-filter-manager.js"
import fs, { read } from 'fs'
import path from 'path'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test.group('BloomFilterManager Functional Tests', (group) => {
  let manager

  group.each.setup(() => {
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 5000, // 5 second for testing
      logger: console,
      backup: true,
      backupTime: 3000, // 3 second for testing
    })
  })

  group.each.teardown(() => {
   manager.destroy()
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

  test('add method throws error when adding non-string', ({ expect }) => {
    expect(() => manager.add(123)).toThrow('Value must be a string');
  });

  test('has method returns true for added values', ({expect}) => {
    const value = 'testValue'
    manager.add(value)
    expect(manager.has(value)).toBe(true)
  })

  test('has method returns false for non-added values', ({expect}) => {
    expect(manager.has('nonExistent')).toBe(false)
  })

  test('reset method clears the Bloom filters and restore', async ({expect}) => {
    manager.add('testValue')
    await manager.resetAndRestore()
    expect(manager.has('testValue')).toBe(true)
  })

  test('reset method clears the Bloom filters and clear data', async ({expect}) => {
    manager.add('testValue')
    await manager.resetAndClearData();
    expect(manager.has('testValue')).toBe(false)
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




  // test('stopRotation method stops the rotation process', ({ expect }) => {
  //   const clearIntervalSpy = sinon.spy(global, 'clearInterval')
  //   manager.rotationInterval = setInterval(() => {}, 1000)
  //   // expect(manager.rotationInterval).toBeDefined()
  //   manager.stopRotation()
  //   expect(manager.rotationInterval).toBeNull()
  //   expect(clearIntervalSpy.calledOnce).toBe(true)
  //   clearIntervalSpy.restore()
  // })

  // test('tokens are correctly rotated and expired after rotateTime', async ({ expect }) => {
  //   const manager = new BloomFilterManager({
  //     numItems: 1000,
  //     fpRate: 0.0001,
  //     rotateTime: 50,
  //     logger: console
  //   })
  //   const tokens = ['alpha', 'beta', 'gamma']
  //   tokens.forEach((token) => manager.add(token))
  //   tokens.forEach((token) => {
  //     expect(manager.has(token)).toBe(true) // check current bloom filter
  //   })
  //   await new Promise((resolve) => setTimeout(resolve, 55))
  
  //   tokens.forEach((token) => {
  //     expect(manager.has(token)).toBe(true) // check previous bloom filter
  //   })
  //   await new Promise((resolve) => setTimeout(resolve, 50))

  //   tokens.forEach((token) => {
  //     expect(manager.has(token)).toBe(false)
  //   })

  //   manager.destroy()
  // })

  // test('backup method should create files when current and previous exist', ({ expect }) => {
  //   const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
  //   const loggerStub = { debug: sinon.stub(), error: sinon.stub()}
  
  //   manager.instanceId = '123'
  //   manager.current = { buckets: new Uint8Array([1,2,3]) }
  //   manager.previous = { buckets: new Uint8Array([4,5,6]) }
  //   manager.logger = loggerStub
  //   manager.backupCurrentPath = path.join(__dirname, '../backup', `current-${manager.instanceId}.blob`);
  //   manager.backupPreviousPath = path.join(__dirname, '../backup', `previous-${manager.instanceId}.blob`);
  
  //   manager.backup()
  
  //   expect(writeFileSyncStub.calledTwice).toBe(true)
  //   expect(writeFileSyncStub.firstCall.args[0]).toBe(manager.backupCurrentPath)
  //   expect(writeFileSyncStub.secondCall.args[0]).toBe(manager.backupPreviousPath)
  //   expect(loggerStub.error.notCalled).toBe(true)
  //   expect(loggerStub.debug.calledTwice).toBe(true)
    
  //   writeFileSyncStub.restore()
  // })

  // test('backupLocal method should create file when current exists', ({ expect }) => {
  //   const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
  //   const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
  
  //   manager.instanceId = '123'
  //   manager.current = { buckets: new Uint8Array([1,2,3]) }
  //   manager.logger = loggerStub
  //   manager.backupCurrentPath = path.join(__dirname, '../backup', `current-${manager.instanceId}.blob`);
  
  //   manager.backupLocal('current')
  
  //   expect(writeFileSyncStub.calledOnce).toBe(true)
  //   expect(writeFileSyncStub.firstCall.args[0]).toBe(manager.backupCurrentPath)
  //   expect(loggerStub.error.notCalled).toBe(true)
  //   expect(loggerStub.debug.calledOnce).toBe(true)
  //   expect(loggerStub.debug.calledWith(`Saved current filter : id ${manager.instanceId}`)).toBe(true)
    
  //   writeFileSyncStub.restore()
  // })

  // test('backupLocal method should create file when previous exists', ({ expect }) => {
  //   const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
  //   const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
  
  //   manager.instanceId = '123'
  //   manager.previous = { buckets: new Uint8Array([1,2,3]) }
  //   manager.logger = loggerStub
  //   manager.backupPreviousPath = path.join(__dirname, '../backup', `current-${manager.instanceId}.blob`);
  
  //   manager.backupLocal('previous')
  
  //   expect(writeFileSyncStub.calledOnce).toBe(true)
  //   expect(writeFileSyncStub.firstCall.args[0]).toBe(manager.backupPreviousPath)
  //   expect(loggerStub.debug.calledOnce).toBe(true)
  //   expect(loggerStub.debug.calledWith(`Saved previous filter : id ${manager.instanceId}`)).toBe(true)
    
  //   writeFileSyncStub.restore
  // })
  
})

 test.group('test', (group) => {

})

// test.group('BloomFilterManager _ensureBackupDirExists', (group) => {
//   let manager
//   let fsStub
//   let loggerStub

//   group.setup(() => {
//     // Création des stubs
//     fsStub = {
//       existsSync: sinon.stub(),
//       readFileSync: sinon.stub()
//     }

//     loggerStub = {
//       debug: sinon.stub(),
//       warn: sinon.stub(),
//       error: sinon.stub(),
//       info: sinon.stub()
//     }
//     // Initialisation d'un BloomFilter pour les tests
//     manager = new BloomFilterManager({
//       numItems: 1000,
//       fpRate: 0.0001,
//       rotateTime: 5000,
//       logger: loggerStub
//     })
//     manager.instanceId = 'test-instance'
//   })

//   group.teardown(() => {
//     // Restore all stubs and destroy the manager
//     sinon.restore()
//     manager.destroy()
//   })

//   test('should create backup directory and log message when it does not exist', ({ expect }) => {
//     const existsSyncStub = sinon.stub(fs, 'existsSync').returns(false)
//     const mkdirSyncStub = sinon.stub(fs, 'mkdirSync');
//     loggerStub.debug.resetHistory()

//     manager._ensureBackupDirExists()

//     const expectedBackupDir = manager.backupDir
//     expect(existsSyncStub.calledOnceWithExactly(expectedBackupDir)).toBe(true)
//     // expect(mkdirSyncStub.calledOnce).toBe(true)
//     // expect(mkdirSyncStub.calledWith(expectedBackupDir)).toBe(true)
//     expect(mkdirSyncStub.calledOnceWithExactly(expectedBackupDir)).toBe(true)
//     expect(loggerStub.debug.calledOnceWithExactly('Backup directory created')).toBe(true)
    
//     existsSyncStub.restore()
//     mkdirSyncStub.restore()
    

//   })

  // test('should not create backup directory or log message when it already exists', ({ expect }) => {
  //   const existsSyncStub = sinon.stub(fs, 'existsSync').returns(true)
  //   const mkdirSyncStub = sinon.stub(fs, 'mkdirSync')
  //   loggerStub.debug.resetHistory()
    
  //   manager._ensureBackupDirExists()
    
  //   // const expectedBackupDir = path.join(__dirname, '../backup')
  //   const expectedBackupDir = manager.backupDir
  //   expect(existsSyncStub.calledOnceWithExactly(expectedBackupDir)).toBe(true)
  //   expect(mkdirSyncStub.notCalled).toBe(true)
  //   expect(loggerStub.debug.notCalled).toBe(true)
    
  //   existsSyncStub.restore()
  //   mkdirSyncStub.restore()
  //   loggerStub.debug.resetHistory()
  // })

