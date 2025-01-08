import { test } from '@japa/runner'
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'
import { Revoker } from '../dist/index.js'
import sinon from 'sinon'
import fs from 'fs'
import { dirname, join } from 'path'
import path from 'path'
import { fileURLToPath } from 'url'
import { log } from 'console'
import logger from '../example/logger.js'
import exp from 'constants'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backupDir = join(__dirname, '../backup');

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

test.group('BloomFilterManager Error Handling', (group) => {
  let manager
  let createBloomFilterStub
  let consoleErrorSpy
  let addStub
  let testStubCurrent

  group.setup(() => {
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      logger: console
    })
    createBloomFilterStub = sinon.stub(manager, '_createBloomFilter').throws(new Error('Test Error'))
    consoleErrorSpy = sinon.spy(console, 'error')
    addStub = sinon.stub(manager.current, 'add').throws(new Error('Add Error'))
  })

  group.teardown(() => {
    createBloomFilterStub.restore()
    consoleErrorSpy.restore()
    addStub.restore()
    manager.destroy()
  })

  test('rotate method logs error when _createBloomFilter throws', ({ expect }) => {
    manager.rotate()
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error rotating Bloom filters:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
  })

  test('add method logs error when current.add throws', ({ expect }) => {
    consoleErrorSpy.resetHistory()
    const value = 'testValue'
    expect(() => manager.add(value)).toThrow('Add Error')
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error adding value to Bloom filter:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Add Error')
  })

  test('reset method logs error when _createBloomFilter throws', ({ expect }) => {
    consoleErrorSpy.resetHistory()
    createBloomFilterStub.throws(new Error('Reset Error'))
    expect(() => manager.reset()).toThrow('Reset Error')
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error resetting Bloom filters:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Reset Error')
  })

  test('has method logs error when current.test throws', ({ expect }) => {
    consoleErrorSpy.resetHistory()
    const value = 'testValue'
    testStubCurrent = sinon.stub(manager.current, 'test').throws(new Error('Test Error'))
    const result = manager.has(value)
    
    expect(result).toBe(false)
    expect(consoleErrorSpy.calledOnce).toBe(true)
    expect(consoleErrorSpy.firstCall.args[0]).toBe('Error in has:')
    expect(consoleErrorSpy.firstCall.args[1].message).toBe('Test Error')
  })

  test('backup previous method should not throw error when previousDone is false', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

    manager.previousDone = false
    manager.previous = null
    manager.logger = loggerStub 
    manager.backupPrevious()

    expect(writeFileSyncStub.notCalled).toBe(true)
    expect(loggerStub.debug.calledOnce).toBe(true)
    expect(loggerStub.debug.calledWith('No previous filter to backup.')).toBe(true)
    writeFileSyncStub.restore()
  })

  test('backup current throw error if current filter not exist', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

    manager.current = null
    manager.logger = loggerStub 
    manager.backupCurrent()

    expect(writeFileSyncStub.notCalled).toBe(true)
    expect(loggerStub.debug.notCalled).toBe(true)
    expect(loggerStub.error.calledWith('Backup failed:')).toBe(true)
    writeFileSyncStub.restore()
  })

  test('backup previous throw error if previous filter not exist and previouDone is true', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }

    manager.previous = null
    manager.previousDone = true
    manager.logger = loggerStub 
    manager.backupPrevious()

    expect(writeFileSyncStub.notCalled).toBe(true)
    expect(loggerStub.debug.notCalled).toBe(true)
    expect(loggerStub.error.calledWith('Backup failed:')).toBe(true)
    writeFileSyncStub.restore()
  })

})

test.group('BloomFilterManager Functional Tests', (group) => {
  let manager

  group.setup(() => {
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 1000, // 1 second for testing
      logger: console
    })
  })

  group.teardown(() => {
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

  test('reset method clears the Bloom filters', ({expect}) => {
    manager.add('testValue')
    manager.reset()
    expect(manager.has('testValue')).toBe(false)
  })

  test('destroy method properly cleans up the manager', ({ expect }) => {
    const clearIntervalSpy = sinon.spy(global, 'clearInterval')
    manager.destroy()
    expect(manager.previous).toBeNull()
    expect(manager.current).toBeNull()
    expect(manager.rotationInterval).toBeNull()
    expect(manager.backupInterval).toBeNull()
    expect(clearIntervalSpy.calledTwice).toBe(true)
    clearIntervalSpy.restore()
  })

  test('stopRotation method stops the rotation process', ({ expect }) => {
    const clearIntervalSpy = sinon.spy(global, 'clearInterval')
    manager.rotationInterval = setInterval(() => {}, 1000)
    // expect(manager.rotationInterval).toBeDefined()
    manager.stopRotation()
    expect(manager.rotationInterval).toBeNull()
    expect(clearIntervalSpy.calledOnce).toBe(true)
    clearIntervalSpy.restore()
  })

  test('tokens are correctly rotated and expired after rotateTime', async ({ expect }) => {
    const manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 20,
      logger: console
    })
    const tokens = ['alpha', 'beta', 'gamma']
    tokens.forEach((token) => manager.add(token))
    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(true) // check current bloom filter
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
  
    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(true) // check previous bloom filter
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    tokens.forEach((token) => {
      expect(manager.has(token)).toBe(false)
    })

    manager.destroy()
  })

  test('backup method should create files when current and previous exist', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
  
    // const manager = new BloomManager(loggerStub)
    manager.instanceId = 'test123'
    manager.current = { buckets: new Uint8Array([1,2,3]) }
    manager.previous = { buckets: new Uint8Array([4,5,6]) }
    manager.logger = loggerStub
  
    manager.backup()
  
    expect(writeFileSyncStub.calledTwice).toBe(true)
    expect(writeFileSyncStub.firstCall.args[0]).toBe('./backup/current.blobtest123')
    expect(writeFileSyncStub.secondCall.args[0]).toBe('./backup/previous.blobtest123')
    expect(loggerStub.debug.calledTwice).toBe(true)
    
    writeFileSyncStub.restore()
  })

  test('backup current method should create file when current exists', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
  
    // const manager = new BloomManager(loggerStub)
    manager.instanceId = 'test123'
    manager.current = { buckets: new Uint8Array([1,2,3]) }
    manager.logger = loggerStub
  
    manager.backupCurrent()
  
    expect(writeFileSyncStub.calledOnce).toBe(true)
    expect(writeFileSyncStub.firstCall.args[0]).toBe('./backup/current.blobtest123')
    expect(loggerStub.debug.calledOnce).toBe(true)
    expect(loggerStub.debug.calledWith('Backup done for current filter : test123')).toBe(true)
    
    writeFileSyncStub.restore()
  })

  test('backup previous method should create file when previous exists', ({ expect }) => {
    const writeFileSyncStub = sinon.stub(fs, 'writeFileSync')
    const loggerStub = { debug: sinon.stub(), error: sinon.stub() }
  
    // const manager = new BloomManager(loggerStub)
    manager.instanceId = 'test123'
    manager.previous = { buckets: new Uint8Array([1,2,3]) }
    manager.logger = loggerStub
    manager.previousDone = true
  
    manager.backupPrevious()
  
    expect(writeFileSyncStub.calledOnce).toBe(true)
    expect(writeFileSyncStub.firstCall.args[0]).toBe('./backup/previous.blobtest123')
    expect(loggerStub.debug.calledOnce).toBe(true)
    expect(loggerStub.debug.calledWith('Backup done for previous filter : test123')).toBe(true)
    
    writeFileSyncStub.restore()
  })
})

test.group('BloomFilterManager _ensureBackupDirExists', (group) => {
  let manager
  let existsSyncStub
  let mkdirSyncStub
  let consoleLogSpy

  group.setup(() => {
    consoleLogSpy = sinon.spy()
    
    // On fournit un logger qui contient debug:
    manager = new BloomFilterManager({
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 2000,
      logger: {
        debug: consoleLogSpy,
        info: console.log,
        warn: console.warn,
        error: console.error
      }
    })
  
    existsSyncStub = sinon.stub(fs, 'existsSync')
    mkdirSyncStub = sinon.stub(fs, 'mkdirSync')
  })

  group.teardown(() => {
    sinon.restore()
    manager.destroy()
  })

  test('should create backup directory and log message when it does not exist', ({ expect }) => {
    // Arrange
    existsSyncStub.returns(false)
    consoleLogSpy.resetHistory();
    manager._ensureBackupDirExists()
    const expectedBackupDir = join(__dirname, '../backup')

    expect(existsSyncStub.calledOnceWithExactly(expectedBackupDir)).toBe(true)
    expect(mkdirSyncStub.calledOnceWithExactly(expectedBackupDir, { recursive: true })).toBe(true)
    expect(consoleLogSpy.calledOnceWithExactly('Dossier de sauvegarde créé')).toBe(true)
  })

  test('should not create backup directory or log message when it already exists', ({ expect }) => {
    existsSyncStub.resetHistory()
    mkdirSyncStub.resetHistory()
    consoleLogSpy.resetHistory();
    existsSyncStub.returns(true)
    manager._ensureBackupDirExists()
    const expectedBackupDir = path.join(__dirname, '../backup')

    expect(existsSyncStub.calledOnceWithExactly(expectedBackupDir)).toBe(true)
    expect(mkdirSyncStub.notCalled).toBe(true)
    expect(consoleLogSpy.notCalled).toBe(true)
  })
})

test.group('Revoker Class Tests', (group) => {
  let destroySpy
  let logger = console

  group.teardown(() => {
    
  })

  test('constructor initializes BloomFilterManager with correct options', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
    }
    const instance = new Revoker(config)
    expect(instance.bloomFilterManager).toBeInstanceOf(BloomFilterManager)
    expect(instance.bloomFilterManager.numItems).toBe(config.numItems)
    expect(instance.bloomFilterManager.fpRate).toBe(config.fpRate)
    expect(instance.bloomFilterManager.rotateTime).toBe(config.rotateTime)
    expect(instance.bloomFilterManager.current).toBeDefined()
    expect(instance.bloomFilterManager.previous).toBeNull()
    expect(instance.bloomFilterManager.rotationInterval).toBeDefined()
    instance.bloomFilterManager.destroy()
  })

  test('constructor initializes middleware with claimsToCheck', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
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
      opaqueHeader: 'Authorization',
      logger
    }
    const instance = new Revoker(config)
    const middleware = instance.getMiddleware()
    expect(middleware).toBeDefined()
    expect(middleware).toBeInstanceOf(Function)
    expect(middleware.length).toBe(3)
    instance.bloomFilterManager.destroy()
  })

  test('add(filterItem) calls bloomFilterManager.add when bloomFilterManager is set', ({ expect }) => {
    const addStub = sinon.stub(BloomFilterManager.prototype, 'add');

    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
    });
    
    const filterItem = 'testItem';
    revoker.add(filterItem);
    expect(addStub.calledWith(filterItem)).toBe(true);
    addStub.restore();
    revoker.destroy();
  });
})

test.group('Revoker Error Handling', (group) => {
  let destroySpy

  group.setup(() => {
    destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
  })

  group.teardown(() => {
    destroySpy.restore()
  })

  test('constructor throws error when neither claimsToCheck nor opaqueHeader is provided', ({ expect }) => {
    expect(() => new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      logger: console
    })).toThrow('claimsToCheck or opaqueHeader must be provided')
    expect(destroySpy.called).toBe(true)
  })

  test('constructor throws error when BloomFilterManager throws error', ({ expect }) => {
    const config = {
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger: console
    }
    const createBloomFilterStub = sinon.stub(BloomFilterManager.prototype, '_createBloomFilter').throws(new Error('Test Error'))
    expect(() => new Revoker(config)).toThrow('Test Error')
    expect(destroySpy.called).toBe(true)
    createBloomFilterStub.restore()
  })

  test('getMiddleware throws error when middleware is not configured', ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger: console
    });
    revoker.middleware = null
    expect(() => revoker.getMiddleware()).toThrow('Middleware not configured');
    revoker.destroy()
  })
})

test.group('Revoker Functional Tests', (group) => {

  test('createJWTMiddleware correctly checks claimsToCheck', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger:  console
    });
    
    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }

    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    
    middleware(req, res, next);
    
    expect(next.calledOnce).toBe(true);
    expect(next.firstCall.args[0]).toBeUndefined();
    
    expect(res.status.notCalled).toBe(true);
    expect(res.json.notCalled).toBe(true);
    expect(res.send.notCalled).toBe(true);
    revoker.destroy();
    });

  // test('createJWTMiddleware throws error when token is missing', ({expect}) => {
  //   const req = {};
  //   const res = {
  //     status: sinon.stub().returnsThis(),
  //     json: sinon.stub(),
  //     send: sinon.stub()
  //   };
  //   const next = sinon.spy();
  //   const revoker = new Revoker({
  //     numItems: 1000,
  //     fpRate: 0.01,
  //     rotateTime: 1000,
  //     claimsToCheck: ['claim1', 'claim2']
  //   });
  //   const createJWTMiddleware = revoker.getMiddleware();
  
  //   expect(() => {
  //     createJWTMiddleware(req, res, next);
  //   }).toThrow(new Error("Missing jwt token"));
  //   revoker.destroy();
  // });

  // test('createJWTMiddleware with missing claimsToCheck', ({expect}) => {
  //   const req = {
  //     token: {
  //       claim1: 'value1',
  //     }
  //   };
  //   const res = {
  //     status: sinon.stub().returnsThis(),
  //     json: sinon.stub(),
  //     send: sinon.stub()
  //   };
  //   const next = sinon.spy();
  //   const revoker = new Revoker({
  //     numItems: 1000,
  //     fpRate: 0.01,
  //     rotateTime: 1000,
  //     claimsToCheck: ['claim1', 'claim2']
  //   });
  //   const createJWTMiddleware = revoker.getMiddleware();

  //   expect(() => {
  //     createJWTMiddleware(req, res, next);
  //   }).toThrow(new Error("Missing claim2 claim in JWT token"));
  //   revoker.destroy();
  // });

  // test('createJWTMiddleware with blacklisted token', ({expect}) => {
  //   const req = {
  //     token: {
  //       claim1: 'value1',
  //       claim2: 'value2'
  //     }
  //   };
  //   const res = {
  //     status: sinon.stub().returnsThis(),
  //     json: sinon.stub(),
  //     send: sinon.stub()
  //   };

  //   const next = sinon.spy();
  //   const revoker = new Revoker({
  //     numItems: 1000,
  //     fpRate: 0.01,
  //     rotateTime: 1000,
  //     claimsToCheck: ['claim1', 'claim2']
  //   });
  //   revoker.add('claim1-value1');
  //   const createJWTMiddleware = revoker.getMiddleware();

  //   expect(() => {
  //     createJWTMiddleware(req, res, next);
  //   }).toThrow(new Error("Token claim1 is blacklisted"));
  //   revoker.destroy();
  // });

  test('createOpaqueMiddleware throws error when header is missing', ({expect}) => {
    const req = {
      headers: {}
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: Authorization"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when authorization header is missing and needed', ({expect}) => {
    const req = {
      headers: {
        Authorization: ''
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: Authorization"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when custom header is missing and needed', ({expect}) => {
    const req = {
      headers: {
        CustomHeader: ''
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };
    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Auth-Token',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error("Missing header: X-Auth-Token"));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when authorization header is invalid', ({expect}) => {
    const req = {
      headers: {
        "authorization": 'randomeValue', // invalid format,Bearer token expected
      }
    };
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }).toThrow(new Error('Invalid authorization header'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when token in Authorization is blacklisted', ({expect}) => {
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();
    const token = 'testToken'
    const req = {
      headers: {
        authorization: 'Bearer ' + token
      }
    };
    revoker.add(token);

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }
    ).toThrow(new Error('Token is blacklisted'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware throws error when token in custom header is blacklisted', ({expect}) => {
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    const next = sinon.spy();
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Auth-Token',
      logger: console
    });
    const createOpaqueMiddleware = revoker.getMiddleware();
    const token = 'testToken'
    const req = {
      headers: {
        'x-auth-token': token
      }
    };
    revoker.add(token);

    expect(() => {
      createOpaqueMiddleware(req, res, next);
    }
    ).toThrow(new Error('Token is blacklisted'));
    revoker.destroy();
  });

  test('createOpaqueMiddleware correctly checks headers receveid an needed', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger: console
    });

    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = {
      headers: {
        authorization: 'Bearer testToken'
      }
    }

    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub(),
      send: sinon.stub()
    };

    middleware(req, res, next);
    expect(next.calledOnce).toBe(true);
    expect(next.firstCall.args[0]).toBeUndefined();
    revoker.destroy();
  
  });
})
