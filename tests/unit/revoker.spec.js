import { test } from '@japa/runner'
import sinon from 'sinon'
import { Revoker } from '#dist/index.js'
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js'
import RevokerStore from '../../dist/revokerStore.js'
import e from 'express'

test.group('Revoker Constructor Validation Tests', (group) => {
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
    sinon.restore() 
  })

  test('Constructor throws error if id is not provided', ({ expect }) => {
    expect(() => new Revoker({
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"id\" is required')      
  });

  test('Constructor throws error if id is not a string', ({ expect }) => {
    expect(() => new Revoker({
      id: 123,
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"id\" must be a string')
  });

  test('Constructor throws error if logger is not provided', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"logger\" is required')
  });

  test('Constructor throws error if logger is not an object', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      logger: 'logger',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"logger\" must be of type object')
  });

  test('Constructor throws error if logger is missing required methods', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      logger: { // logger is missing the error method
        info: sinon.spy(),
        warn: sinon.spy(),
        debug: sinon.spy(),
      },
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"logger.error\" is required')
  });

  test('Constructor throws error if claimsToCheck and opaqueHeader are not provided together', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"claimsToCheck\" is required') //first error
  });

  test('Constructor throws error if opaqueHeader and claimsToCheck are provided together', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"claimsToCheck\" is not allowed') // First error
  });

  test('Constructor throws error if claimsToCheck is not an array', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: 'claim1',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"claimsToCheck\" must be an array')
  });

  test('Constructor throws error if claimsToCheck is an empty array', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: [],
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"claimsToCheck\" must contain at least 1 items')
  });

  test('Constructor throws error if claimsToCheck contains non-string values', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 123],
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"claimsToCheck[1]\" must be a string')
  });

  test('Constructor throws error if claimsToCheck is provided and payloadKey is not provided', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"payloadKey\" is required')
  });

  test('Constructor throws error if claimsToCheck is provided and payloadKey is not a string', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 123,
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"payloadKey\" must be a string')
  });

  test('Constructor throws error if opaqueHeader is not a string', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      opaqueHeader: 123,
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Invalid input: \"opaqueHeader\" must be a string')
  });

  test('Constructor throws error if filter is not provided', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger
    })).toThrow('Invalid input: \"filter\" is required')
  });

  test('Constructor throws error if filter is not an object', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: 'filter'
    })).toThrow('Invalid input: \"filter\" must be of type object')
  });

  test('Constructor throws error if grpcEnabled is true and grpcPort is not provided', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true
    })).toThrow('Invalid input: \"grpcPort\" is required')
  });

  test('Constructor throws error if grpcEnabled is not a boolean', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: 'true',
      grpcPort: '50051',
    })).toThrow('Invalid input: \"grpcEnabled\" must be a boolean')
  });

  test('Constructor throws error if grpcPort is provide and GrpcEnabled is not provided', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcPort: '50051',
    })).toThrow('Invalid input: \"grpcPort\" is not allowed')
  });

  test('Constructor throws error if grpcPort is not a number', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: "50051",
    })).toThrow('Invalid input: \"grpcPort\" must be a number')
  });

    test('Constructor throws error if BloomFilterManager initialization fails', async ({ expect }) => {
    // const error = new Error('Initialization failed')
    // sinon.stub(BloomFilterManager.prototype, 'constructor').throws(error)
    expect(() => new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        // numItems: 1000, <- Missing required parameter, should throw an error
        fpRate: 0.01,
        rotateTime: 2000
      }
    })).toThrow('Failed to initialize BloomFilterManager: Invalid input: \"numItems\" is required')
  })

  test('Constructor not throws error if grpcEnabled is false and grpcPort is not provided', async ({ expect }) => {
    let revoker;
    expect(() => revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: false,
    })).not.toThrow()

    await revoker.destroy()
  });

  test('Constructor not throws error if all required parameters are provided for JWT', async ({ expect }) => {
    let revoker;
    expect(() => revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051,
    })).not.toThrow()
    await revoker.destroy()
  });

  test('Constructor not throws error if all required parameters are provided for Opaque', ({ expect }) => {
    expect(() => new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: '50051',
    }).not.toThrow())
  });

  test('Constructor initializes BloomFilterManager with correct parameters', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000,
        backup: true,
        backupRatioTime: 2
      }
    })

    expect(revoker.bloomFilterManager.id).toBe('test')
    expect(revoker.bloomFilterManager.numItems).toBe(1000)
    expect(revoker.bloomFilterManager.fpRate).toBe(0.01)
    expect(revoker.bloomFilterManager.rotateTime).toBe(2000)
    expect(revoker.bloomFilterManager.backupEnabled).toBe(true)
    expect(revoker.bloomFilterManager.backupRatioTime).toBe(2)
    await revoker.destroy()
  })

})

// Tests de la classe Revoker
test.group('Revoker Class Tests', (group) => {
  let logger
  // let destroySpy

  group.each.setup(() => {
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }
    // destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
  })


  group.each.teardown(() => {
    // destroySpy.restore();
    sinon.restore();
  })

  test('grpcInit method do nothing if grpcEnabled is false', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: false,
    })

    await revoker._grpcInit()
    expect(Revoker.grpcServerStarted).toBe(false)
    await revoker.destroy()
  })

  test('grpcInit method do nothing if grpcEnabled is omitted', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })

    await revoker._grpcInit()
    expect(Revoker.grpcServerStarted).toBe(false)
    await revoker.destroy()
  })

  test('grpcInit method starts gRPC server if grpcEnabled is true', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: true,
        grpcPort: 50051
      },
      {
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    await revoker._grpcInit()
    expect(revokerStore.init.calledOnce).toBe(true)
    expect(startServerSpy.calledOnceWithExactly(50051, RevokerStore, logger)).toBe(true)
    expect(revokerStore.registerInstance.calledOnceWithExactly(revoker)).toBe(true)
    expect(Revoker.grpcServerStarted).toBe(true)
    await revoker.destroy()
  })

  test('grpcInit method only register instance ig grpcServerStarted is true', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: true,
        grpcPort: 50051
      },
      {
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    Revoker.grpcServerStarted = true
    await revoker._grpcInit()
    expect(revokerStore.init.calledOnce).toBe(false)
    expect(startServerSpy.calledOnce).toBe(false)
    expect(revokerStore.registerInstance.calledOnceWithExactly(revoker)).toBe(true)
    expect(Revoker.grpcServerStarted).toBe(true)
    await revoker.destroy()
  })

  test('grpcInit method logs error if startServer fails', async ({ expect }) => {
    const startServerSpy = sinon.stub().throws(new Error('Start server failed'));
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: true,
        grpcPort: 50051
      },
      {
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    await expect(revoker._grpcInit()).rejects.toThrow('Failed to start gRPC server: Start server failed')
    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Failed to start gRPC server: Start server failed')
    await revoker.destroy()
  })

  test('grpcInit method logs error if registerInstance fails', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();
    
    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.stub().throws(new Error('Register instance failed')),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: true,
        grpcPort: 50051
      },
      {
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    await expect(revoker._grpcInit()).rejects.toThrow('Failed to start gRPC server: Register instance failed')
    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Failed to start gRPC server: Register instance failed')
    await revoker.destroy()
  })



  test('add method handles empty or invalid input', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    expect(() => revoker.add('')).toThrow('Value must be a non-empty string')
    expect(() => revoker.add(null)).toThrow('Value must be a non-empty string')
    expect(() => revoker.add(undefined)).toThrow('Value must be a non-empty string')

    await revoker.destroy()
  })

  test('add method handles null bloomFilterManager', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    expect(() => revoker.add('test')).toThrow('Bloom filter manager not initialized');
    await revoker.destroy()
  })

  test('add throws error when gRPC is enabled', async ({ expect }) => {
    let revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051
    })
    console.log(revoker.constructor)
    await revoker._grpcInit()
    console.log('toto')

    expect(() => revoker.add('test')).toThrow('gRPC is enabled, use the gRPC method instead')
    await revoker.destroy()
  })

  test('add calls bloomFilterManager.add and throws error if add fails', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const addStub = sinon.stub(revoker.bloomFilterManager, 'add').throws(new Error('Add failed'))
    expect(() => revoker.add('test')).toThrow('Add failed')
    expect(addStub.calledOnceWithExactly('test')).toBe(true)
    await revoker.destroy()
  })

  test('has calls bloomFilterManager.has and throws error if has fails', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const hasStub = sinon.stub(revoker.bloomFilterManager, 'has').throws(new Error('Has failed'))
    expect(() => revoker.has('test')).toThrow('Has failed')
    expect(hasStub.calledOnceWithExactly('test')).toBe(true)
    await revoker.destroy()
  })

  test('has throws error when bloomFilterManager is null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    expect(() => revoker.has('test')).toThrow('Bloom filter manager not initialized');
    await revoker.destroy()
  })

  test('has method throws error when gRPC is enabled', async ({ expect }) => {
    let revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051
    })
    await revoker._grpcInit()
    expect(() => revoker.has('test')).toThrow('gRPC is enabled, use the gRPC method instead')
    await revoker.destroy()
  })

  test('has method handles empty or invalid input', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    expect(() => revoker.has('')).toThrow('Value must be a non-empty string')
    expect(() => revoker.has(null)).toThrow('Value must be a non-empty string')
    expect(() => revoker.has(undefined)).toThrow('Value must be a non-empty string')

    await revoker.destroy()
  })

  test('getMetrics calls bloomFilterManager.getMetrics', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const getMetricsStub = sinon.stub(revoker.bloomFilterManager, 'getMetrics').returns({ test: 'metrics' })
    const metrics = revoker.getMetrics()
    expect(metrics).toEqual({ test: 'metrics' })
    expect(getMetricsStub.calledOnce).toBe(true)
    await revoker.destroy()
  })

  test('getMetrics logs error when bloomFilterManager is null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    expect(() => revoker.getMetrics()).toThrow('Bloom filter manager not initialized');
    await revoker.destroy()
  })

  // test('getMetrics logs error if getMetrics fails', async ({ expect }) => {
  //   const revoker = new Revoker({
  //     id: 'test',
  //     claimsToCheck: ['claim1'],
  //     payloadKey: 'token',
  //     logger,
  //     filter: {
  //       numItems: 1000,
  //       fpRate: 0.01,
  //       rotateTime: 2000
  //     }
  //   })

  //   const getMetricsStub = sinon.stub(revoker.bloomFilterManager, 'getMetrics').throws(new Error('Get metrics failed'))
  //   expect(() => revoker.getMetrics()).toThrow('Get metrics failed')
  //   expect(getMetricsStub.calledOnce).toBe(true)
  //   expect(logger.error.calledOnce).toBe(true)
  //   expect(logger.error.firstCall.args[0]).toBe('Error in Revoker.getMetrics:')
  //   expect(logger.error.firstCall.args[1].message).toBe('Get metrics failed')
  //   await revoker.destroy()
  // })

  test('reset and restore method throw error when bloomFilterManager is null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    await expect(revoker.resetAndRestore()).rejects.toThrow('Bloom filter manager not initialized');
    await revoker.destroy()
  })

  test('resetAndRestore calls bloomFilterManager.resetAndRestore', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const resetAndRestoreStub = sinon.stub(revoker.bloomFilterManager, 'resetAndRestore').resolves()
    logger.info.resetHistory()
    await revoker.resetAndRestore()
    expect(resetAndRestoreStub.calledOnce).toBe(true)
    expect(logger.info.calledOnceWithExactly('Bloom filter has been reset and restored successfully.')).toBe(true)
    await revoker.destroy()
  })

  test('resetAndRestore calls bloomFilterManager.resetAndRestore and logs error if resetAndRestore fails', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const resetAndRestoreStub = sinon.stub(revoker.bloomFilterManager, 'resetAndRestore').rejects(new Error('Reset failed'))
    await expect(revoker.resetAndRestore()).rejects.toThrow('Reset failed')
    expect(resetAndRestoreStub.calledOnce).toBe(true)
    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Error in Revoker.resetAndRestore:')
    expect(logger.error.firstCall.args[1].message).toBe('Reset failed')
    await revoker.destroy()
  })

  test('resetAndRestore throws error when gRPC is enabled', async ({ expect }) => {
    let revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051
    })
    await revoker._grpcInit()
    await expect(() => revoker.resetAndRestore()).rejects.toThrow('gRPC is enabled, use the gRPC method instead')
    await revoker.destroy()
  })

  test('resetAndClearData throws error when gRPC is enabled', async ({ expect }) => {
    let revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051
    })
    await revoker._grpcInit()
    await expect(() => revoker.resetAndClearData()).rejects.toThrow('gRPC is enabled, use the gRPC method instead')
    await revoker.destroy()
  })

  test('resetAndClearData calls bloomFilterManager.resetAndClearData and logs error if resetAndClearData fails', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const resetAndClearDataStub = sinon.stub(revoker.bloomFilterManager, 'resetAndClearData').rejects(new Error('Reset failed'))
    await expect(revoker.resetAndClearData()).rejects.toThrow('Reset failed')
    expect(resetAndClearDataStub.calledOnce).toBe(true)
    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Error in revoker.resetAndClearData:')
    expect(logger.error.firstCall.args[1].message).toBe('Reset failed')
    await revoker.destroy()
  })

  test('ResetAndClearData trhow error when bloomFilterManager is null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    await expect(async () => await revoker.resetAndClearData()).rejects.toThrow('Bloom filter manager not initialized');
    await revoker.destroy()
  })

  test('resetAndClearData calls bloomFilterManager.resetAndClearData', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const resetAndClearDataStub = sinon.stub(revoker.bloomFilterManager, 'resetAndClearData').resolves()
    logger.info.resetHistory()
    await revoker.resetAndClearData()
    expect(resetAndClearDataStub.calledOnce).toBe(true)
    expect(logger.info.calledOnceWithExactly('Bloom filter has been reset and data cleared successfully.')).toBe(true)
    await revoker.destroy()
  })

  test('destroy logs error if destroy fails', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const destroyStub = sinon.stub(revoker.bloomFilterManager, 'destroy').throws(new Error('Destroy failed'))
    await expect(revoker.destroy()).rejects.toThrow('Failed to destroy Revoker: Destroy failed')
    expect(destroyStub.calledOnce).toBe(true)
    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Error during Revoker destruction:')
    expect(logger.error.firstCall.args[1].message).toBe('Destroy failed')
    destroyStub.restore()
    await revoker.destroy()
  })

  test('destroy do nothing if grpcEnabled is false', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.spy()
    }
    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: false,
      },{
        startServerSpy,
        stopServerSpy
      },
      revokerStore
    )

    await revoker.destroy()
    expect(revokerStore.unregisterInstance.called).toBe(false)
    expect(Revoker.grpcServerStarted).toBe(false)
  })

  test('destroy do nothing if grpcEnabled is omitted', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
      },{
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    await revoker.destroy()
    expect(revokerStore.unregisterInstance.called).toBe(false)
    expect(revokerStore.isEmpty.called).toBe(false)
    expect(revokerStore.destroy.called).toBe(false)
    expect(stopServerSpy.called).toBe(false)
    expect(Revoker.grpcServerStarted).toBe(false)
  })

  test('destroy calls unregisterInstance and stopServer if grpcEnabled is true', async ({ expect }) => {
    const startServerSpy = sinon.spy();
    const stopServerSpy = sinon.spy();

    const revokerStore = {
      init : sinon.spy(),
      registerInstance : sinon.spy(),
      unregisterInstance : sinon.spy(),
      isEmpty: sinon.stub().returns(true),
      destroy: sinon.spy()
    }

    const revoker = new Revoker({
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: {
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 2000
        },
        grpcEnabled: true,
        grpcPort: 50051
      },
      {
        startServerFn: startServerSpy,
        stopServerFn: stopServerSpy
      },
      revokerStore
    )

    await revoker._grpcInit()
    expect(Revoker.grpcServerStarted).toBe(true)

    await revoker.destroy()
    expect(revokerStore.unregisterInstance.calledOnceWithExactly(revoker.id)).toBe(true)
    expect(revoker.grpcEnabled).toBe(false)
    expect(revokerStore.isEmpty.calledAfter(revokerStore.unregisterInstance)).toBe(true)
    expect(revokerStore.isEmpty.calledOnce).toBe(true)
    expect(revokerStore.destroy.calledAfter(revokerStore.isEmpty)).toBe(true)
    expect(revokerStore.destroy.calledOnce).toBe(true)
    await expect(stopServerSpy.calledAfter(revokerStore.destroy)).toBe(true)
    await expect(stopServerSpy.calledOnceWithExactly(logger)).toBe(true)
    expect(Revoker.grpcServerStarted).toBe(false)
  })



  test('destroy logs warning if bloomFilterManager is already destroyed', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    const manager = revoker.bloomFilterManager // Save the manager for destruction later
    revoker.bloomFilterManager = null
    await revoker.destroy()
    expect(logger.warn.calledOnceWithExactly('Bloom filter manager already destroyed')).toBe(true)
    // Restore the manager for correct cleanup
    revoker.bloomFilterManager = manager
    await revoker.destroy()
  })


  test('destroy method handles multiple calls safely', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    await revoker.destroy()
    expect(async() => await revoker.destroy()).not.toThrow()
    expect(revoker.bloomFilterManager).toBeNull()
  })

  test('destroy method handles multiple calls safely and sets bloomFilterManager to null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    await revoker.destroy()
    expect(async () => await revoker.destroy()).not.toThrow()
    expect(revoker.bloomFilterManager).toBeNull() // This line was already covered, but it's good to keep it
  })

  test('destroy method calls destroy on bloomFilterManager', async ({ expect }) => {
    const destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })

    await revoker.destroy()
    expect(destroySpy.calledOnce).toBe(true)
    expect(revoker.bloomFilterManager).toBeNull()
    expect(revoker.middleware).toBeNull()
    destroySpy.restore()
  })

  test('getMiddleware throws error if middleware is not present', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    });
    revoker.middleware = null;
    expect(() => revoker.getMiddleware()).toThrow("Middleware not configured");
    await revoker.destroy();
  })

  test('bloom filter restet is called if reset revoker is called', async({ expect }) => {
    const resetSpy = sinon.spy(BloomFilterManager.prototype, 'resetAndRestore');
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    });
    await revoker.resetAndRestore();
    expect(resetSpy.calledOnce).toBe(true);
    await revoker.destroy();
  })
})

// Tests supplémentaires pour les Middlewares
test.group('Extended Middleware Tests', (group) => {
  let logger
  let revoker

  group.each.setup(() => {
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }
  })

  group.each.teardown(async () => {
    if (revoker) {
      await revoker.destroy()
    }
  })

  test('JWT Middleware - handles non-string claim values', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    
    const middleware = revoker.getMiddleware()
    const next = sinon.spy()
    const req = {
      token: {
        claim1: { nested: 'value' } // Valeur d'objet non-string
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    middleware(req, res, next)
    expect(next.called).toBe(true)
    await revoker.destroy()
  })

  test('JWT Middleware - handles array of claim values', async ({ expect }) => {
    revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    
    const middleware = revoker.getMiddleware()
    const next = sinon.spy()
    const req = {
      token: {
        claim1: ['value1', 'value2']
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    middleware(req, res, next)
    expect(next.called).toBe(true)
  })

  test('Opaque Middleware - handles empty string token', async ({ expect }) => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    
    const middleware = revoker.getMiddleware()
    const next = sinon.spy()
    const req = {
      headers: {
        authorization: 'Bearer '
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Invalid authorization header')
    }
  })

  test('Opaque Middleware - handles malformed Bearer token', async ({ expect }) => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    
    const middleware = revoker.getMiddleware()
    const next = sinon.spy()
    const req = {
      headers: {
        authorization: 'Bearer token extra'
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Invalid authorization header')
    }
  })

  test('Opaque Middleware - handles case-insensitive header names', async ({ expect }) => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'X-Custom-Token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      }
    })
    
    const middleware = revoker.getMiddleware()
    const next = sinon.spy()
    const req = {
      headers: {
        'x-custom-token': 'validToken'
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    middleware(req, res, next)
    expect(next.calledOnce).toBe(true)
  })
});

test.group('Revoker Class - gRPC Tests', (group) => {
  let logger = {
    info: sinon.spy(),
    warn: sinon.spy(),
    debug: sinon.spy(),
    error: sinon.spy()
  }

  let revoker

  group.setup(async () => {
    revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
      grpcEnabled: true,
      grpcPort: 50051
    })
    await revoker._grpcInit()
  })

  group.teardown(async () => {
    if (revoker) {
      await revoker.destroy()
    }
  })

  test('All exposed throws error when gRPC is enabled', async ({ expect }) => {
    expect(() => revoker.has('test')).toThrow('gRPC is enabled, use the gRPC method instead')
    expect(() => revoker.getMetrics()).toThrow('gRPC is enabled, use the gRPC method instead')
    await expect(revoker.resetAndRestore()).rejects.toThrow('gRPC is enabled, use the gRPC method instead')
    await expect(revoker.resetAndClearData()).rejects.toThrow('gRPC is enabled, use the gRPC method instead')
  })
})


  