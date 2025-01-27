import { test } from '@japa/runner'
import sinon from 'sinon'
import { Revoker } from '../dist/index.js'
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'

test.group('Middleware Tests', (group) => {  
  let logger
  let req
  let res
  let next

  group.each.setup(() => {
    process.env.NODE_ENV = 'test'
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }
    req = {}
    res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }
    next = sinon.spy()
  })

  group.each.teardown(() => {
    sinon.restore() // Restaure tous les stubs, fakes et mocks Sinon.
  })

  test('JWT Middleware - if in development mode, logger is called', async ({ expect }) => {
    process.env.NODE_ENV = 'development'
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000
      },
    })

    const middleware = revoker.getMiddleware()
    const req = {
      token: {
        claim: 'value'
      }
    }

    revoker.add('claim-value') // Blacklist the claim
    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.warn.called).toBe(false)
    expect(logger.error.called).toBe(false)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - missing token', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.info.calledWith('Missing jwt token'))
    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Invalid token!')
    })
    await revoker.resetAndClearData();
    await revoker.destroy()

  })

  test('JWT Middleware - missing required claim', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
     
    const middleware = revoker.getMiddleware()
    req = {
      token: {
        claim1: 'value1'
      }
    }
    
    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.info.calledWith('Missing claim2 in jwt token'))
    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Invalid token!')
    })
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - valid token with all required claims', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }
    middleware(req, res, next)
    console.log(next.called)
    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - valid token with all required claims and blacklisted claim', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })

    const middleware = revoker.getMiddleware()
    revoker.add('claim1-value1') // Blacklist le claim

    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }

    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Invalid token!')
    })
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - log internal error', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1', 'claim2'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })

    const middleware = revoker.getMiddleware()
    const error = new Error('Internal error')
    const next = sinon.stub().throws(error)
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }

    middleware(req, res, next)

    expect(logger.error.calledOnceWithExactly(error))
    expect(res.status.calledWith(500)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'internal_error',
      message: expect.stringContaining('An unexpected error occurred')
    })
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - if in development mode, logger is called', async ({ expect }) => {
    process.env.NODE_ENV = 'development'
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    const req = {
      headers: {
        authorization
        : 'Bearer validToken'
      }
    }

    revoker.add('validToken') // Blacklist le token
    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.warn.called).toBe(false)
    expect(logger.error.called).toBe(false)
    await revoker.resetAndClearData();
    await revoker.destroy()

  })

  test('Opaque Middleware - valid Authorization header', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      headers: {
        authorization: 'Bearer validToken'
      }
    }

    middleware(req, res, next)

    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - missing Authorization header', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      headers: {}
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Missing header: Authorization')
    }

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - invalid Authorization header format', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      headers: {
        authorization: 'InvalidFormat'
      }
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Invalid authorization header')
    }

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - blacklisted token', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const token = 'validToken'
    revoker.add(token) // Blacklist le token
    
    const middleware = revoker.getMiddleware()
    req = {
      headers: {
        authorization: `Bearer ${token}`
      }
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe(`Token ${token} is blacklisted`)
    }

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - custom header validation', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'X-Custom-Token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      headers: {
        'x-custom-token': 'validToken'
      }
    }

    middleware(req, res, next)

    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - log internal error', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000
      },
    })

    const middleware = revoker.getMiddleware()
    const error = new Error('Internal error')
    const next = sinon.stub().throws(error)
    req = {
      headers: {
        authorization
        : 'Bearer validToken'
      }
    }

    middleware(req, res, next)

    expect(logger.error.calledOnceWithExactly(error))
    expect(res.status.calledWith(500)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'internal_error',
      message: expect.stringContaining('An unexpected error occurred')
    })
    await revoker.resetAndClearData();
    await revoker.destroy()
  })

//   test('JWT Middleware - throttleJWT is called in non-development mode with warn message', async ({ expect }) => {
//     process.env.NODE_ENV = 'production';
//     const revoker = new Revoker({
//       numItems: 1000,
//       fpRate: 0.01,
//       rotateTime: 1000,
//       claimsToCheck: ['claim1'],
//       logger
//     });

//     const throttleJWTStub = sinon.stub(revoker, 'throttleJWT');
  
//     const middleware = revoker.getMiddleware();
//     const next = sinon.spy();
//     const req = { token: { claim1: 'value1' } }; // Blacklisted claim
//     const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
  
//     revoker.add('claim1-value1'); // Blacklist the claim to trigger the throttled message
  
//     middleware(req, res, next);

//     expect(throttleJWTStub.called).toBe(true);
//     expect(throttleJWTStub.calledOnce).toBe(true);
//     expect(throttleJWTStub.firstCall.args[0]).toBe('Token claim1 is blacklisted');
//     expect(throttleJWTStub.firstCall.args[1]).toBe(true); // isError flag should be true
  
//     throttleJWTStub.restore(); // Restore the stubbed method
//     process.env.NODE_ENV = 'test'; // Reset to default environment
//     await revoker.resetAndClearData();
//     await revoker.destroy();
//   });

//   test('Opaque Middleware - throttleOpaque is called in non-development mode with warn message', async ({ expect }) => {
//     process.env.NODE_ENV = 'production';
//     const throttleOpaqueStub = sinon.stub(Revoker.prototype, 'throttleOpaque'); // Stub the throttleOpaque method
//     const revoker = new Revoker({
//       numItems: 1000,
//       fpRate: 0.01,
//       rotateTime: 1000,
//       opaqueHeader: 'Authorization',
//       logger
//     });
  
//     const middleware = revoker.getMiddleware();
//     const next = sinon.spy();
//     const token = 'testToken';
//     const req = { headers: { authorization: `Bearer ${token}` } }; // Invalid token to trigger a warning
//     const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
  
//     revoker.add(token); // Blacklist the token to trigger the throttled message
  
//     middleware(req, res, next);
  
//     expect(throttleOpaqueStub.calledOnce).toBe(true);
//     expect(throttleOpaqueStub.firstCall.args[0]).toBe(`Token ${token} is blacklisted`);
//     expect(throttleOpaqueStub.firstCall.args[1]).toBe(true);
  
//     throttleOpaqueStub.restore(); // Restore the stubbed method
//     process.env.NODE_ENV = 'test'; // Reset to default environment
//     await revoker.destroy();
//   });

})

test.group('Revoker Constructor Validation Tests', (group) => {
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
    sinon.restore() 
    // destroySpy.restore()
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

  test('Constructor throws error if grpcPort is not a string', ({ expect }) => {
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
      grpcPort: 50051,
    })).toThrow('Invalid input: \"grpcPort\" must be a string')
  });

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
      grpcPort: '50051',
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
      }
    }).not.toThrow())
  });

})

// Tests de la classe Revoker
test.group('Revoker Class Tests', (group) => {
  let logger
  let destroySpy

  group.each.setup(() => {
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }
    destroySpy = sinon.spy(BloomFilterManager.prototype, 'destroy')
  })


  group.each.teardown(() => {
    destroySpy.restore()
  })

  test('constructor initializes throttle functions properly', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    expect(typeof revoker.throttleJWT).toBe('function')
    expect(typeof revoker.throttleOpaque).toBe('function')
    await revoker.destroy()
  })

  test('add method handles empty or invalid input', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    expect(() => revoker.add('')).toThrow('Value must be a non-empty string')
    expect(() => revoker.add(null)).toThrow('Value must be a non-empty string')
    expect(() => revoker.add(undefined)).toThrow('Value must be a non-empty string')

    await revoker.destroy()
  })

  test('destroy method handles multiple calls safely', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    await revoker.destroy()
    expect(async() => await await revoker.destroy()).not.toThrow()
    expect(revoker.bloomFilterManager).toBeNull()
  })

  test('add method handles null bloomFilterManager', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    expect(async () => await revoker.add('test')).not.toThrow();//Should not throw an error
    await revoker.destroy()
  })

  test('reset method handles null bloomFilterManager', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })
    revoker.bloomFilterManager.destroy()
    revoker.bloomFilterManager = null; // Simulate a null manager
    expect(() => revoker.resetAndRestore()).not.toThrow();//Should not throw an error
    await revoker.destroy()
  })

  test('destroy method handles multiple calls safely and sets bloomFilterManager to null', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    await revoker.destroy()
    expect(async () => await await revoker.destroy()).not.toThrow()
    expect(revoker.bloomFilterManager).toBeNull() // This line was already covered, but it's good to keep it
  })

  test('destroy method calls destroy on bloomFilterManager', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    await revoker.destroy()
    expect(destroySpy.calledOnce).toBe(true)
  })

  test('getMiddleware throws error if middleware is not present', async ({ expect }) => {
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    });
    revoker.middleware = null;
    expect(() => revoker.getMiddleware()).toThrow("Middleware not configured");
    await revoker.destroy();
  })

  test('bloom Filter is destroyedif opaqueHeader or claimsToCheck is not provided', ({ expect }) => {
    expect(() => {
      new Revoker({
        id: 'test',
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000,
        logger
      });
    }).toThrow('claimsToCheck or opaqueHeader must be provided');
      expect(destroySpy.calledOnce).toBe(true);
      expect(logger.error.calledOnceWithExactly('Opaque header or claims to check must be provided'));

  })

  test('bloom filter restet is called if reset revoker is called', async({ expect }) => {
    const resetSpy = sinon.spy(BloomFilterManager.prototype, 'resetAndRestore');
    const revoker = new Revoker({
      id: 'test',
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Custom-Token',
      logger
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


  // test('JWT Middleware - throttle is called in non-development mode', async ({ expect }) => {
  //   process.env.NODE_ENV = 'production';
  //   const logOrThrottleStub = sinon.stub(Revoker.prototype, 'logOrThrottle');

  //   revoker = new Revoker({
  //       numItems: 1000,
  //       fpRate: 0.01,
  //       rotateTime: 1000,
  //       claimsToCheck: ['claim1'],
  //       logger,
  //   });

  //   const middleware = revoker.getMiddleware();
  //   const next = sinon.spy();
  //   const req = { token: { claim1: 'value1' } };
  //   const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };

  //   logger.info.resetHistory();
  //   logger.warn.resetHistory();
  //   revoker.add('claim1-value1'); // Blacklist the claim
  //   middleware(req, res, next);

  //   expect(logOrThrottleStub.called).toBe(true);
  //   expect(logger.info.called).toBe(true);
  //   expect(logger.warn.called).toBe(false);
  //   expect(logger.error.calledOnceWithExactly('Token claim1 is blacklisted'));
  //   process.env.NODE_ENV = 'test';
  //   logOrThrottleStub.restore();
  //   await revoker.destroy();
  // });

  // test('Opaque Middleware - throttle is called in non-development mode', async ({ expect }) => {
  //   process.env.NODE_ENV = 'production';
  //   // logger = { info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
  //   const throttleOpaqueStub = sinon.spy();

  //   revoker = new Revoker({
  //       numItems: 1000,
  //       fpRate: 0.01,
  //       rotateTime: 1000,
  //       opaqueHeader: 'Authorization',
  //       logger,
  //   });

  //   const middleware = revoker.getMiddleware();
  //   const next = sinon.spy();
  //   const token = 'testToken';
  //   const req = { headers: { authorization: `Bearer ${token}` } };
  //   const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };

  //   logger.info.resetHistory();
  //   logger.warn.resetHistory();
  //   await revoker.add(token);
    
  //   middleware(req, res, next);

  //   expect(throttleOpaqueStub.called).toBe(true); // Because the stub is not used inside the middleware
  //   expect(logger.info.called).toBe(true);
  //   expect(logger.warn.called).toBe(false);
  //   expect(logger.error.calledOnceWithExactly(`Token ${token} is blacklisted`));
  //   process.env.NODE_ENV = 'test';
  //   await await revoker.destroy();


  });

  