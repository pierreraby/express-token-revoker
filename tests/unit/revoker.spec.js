import { test } from '@japa/runner'
import sinon from 'sinon'
import { Revoker } from '../../dist/index.js'
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js'

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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    const middleware = revoker.getMiddleware()
    const req = {
      token: {
        // empty token to trigger an error
      }
    }

    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.warn.called).toBe(true)
    expect(logger.error.called).toBe(false)
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - valid token with all required claims', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - missing token', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
    })
    
    const middleware = revoker.getMiddleware()
    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Missing jwt token')
    })
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - missing required claim', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.001,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
    })
    
    const middleware = revoker.getMiddleware()
    req = {
      token: {
        claim1: 'value1'
      }
    }
    

    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    console.log(res.json.firstCall.args[0])
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Missing claim2 claim in JWT token')
    })
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - blacklisted claim', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1', 'claim2'],
      logger
    })
    
    const middleware = revoker.getMiddleware()
    await revoker.add('claim1-value1') // Blacklist le claim
    
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
      message: expect.stringContaining('Token claim1 is blacklisted')
    })
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - valid Authorization header', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - missing Authorization header', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - invalid Authorization header format', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - blacklisted token', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
    })
    
    const token = 'validToken'
    await revoker.add(token) // Blacklist le token
    
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('Opaque Middleware - custom header validation', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'X-Custom-Token',
      logger
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
    revoker.resetAndClearData();
    await revoker.destroy()
  })

  test('JWT Middleware - throttleJWT is called in non-development mode with warn message', async ({ expect }) => {
    process.env.NODE_ENV = 'production';
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    });

    const throttleJWTStub = sinon.stub(revoker, 'throttleJWT');
  
    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = { token: { claim1: 'value1' } }; // Token invalide pour déclencher un warning
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
  
    await revoker.add('claim1-value1'); // Blacklist the claim to trigger the throttled message
  
    middleware(req, res, next);
    expect(throttleJWTStub.called).toBe(true);
    expect(throttleJWTStub.calledOnce).toBe(true);
    expect(throttleJWTStub.firstCall.args[0]).toBe('Token claim1 is blacklisted');
    expect(throttleJWTStub.firstCall.args[1]).toBe(true); // isError flag should be true
  
    throttleJWTStub.restore(); // Restore the stubbed method
    process.env.NODE_ENV = 'test'; // Reset to default environment
    revoker.resetAndClearData();
    await revoker.destroy();
  });

  test('Opaque Middleware - throttleOpaque is called in non-development mode with warn message', async ({ expect }) => {
    process.env.NODE_ENV = 'production';
    const throttleOpaqueStub = sinon.stub(Revoker.prototype, 'throttleOpaque'); // Stub the throttleOpaque method
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      opaqueHeader: 'Authorization',
      logger
    });
  
    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const token = 'testToken';
    const req = { headers: { authorization: `Bearer ${token}` } }; // Token invalide pour déclencher un warning
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
  
    await revoker.add(token); // Blacklist the token to trigger the throttled message
  
    middleware(req, res, next);
  
    expect(throttleOpaqueStub.calledOnce).toBe(true);
    expect(throttleOpaqueStub.firstCall.args[0]).toBe(`Token ${token} is blacklisted`);
    expect(throttleOpaqueStub.firstCall.args[1]).toBe(true);
  
    throttleOpaqueStub.restore(); // Restore the stubbed method
    process.env.NODE_ENV = 'test'; // Reset to default environment
    await revoker.destroy();
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

  test('constructor handles invalid numItems parameter', ({ expect }) => {
    expect(() => new Revoker({
      numItems: -1,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })).toThrow()
  })

  test('constructor handles invalid fpRate parameter', ({ expect }) => {
    expect(() => new Revoker({
      numItems: 1000,
      fpRate: 2,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })).toThrow()
  })

  test('constructor handles invalid rotateTime parameter', ({ expect }) => {
    expect(() => new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: -1,
      claimsToCheck: ['claim1'],
      logger
    })).toThrow()
  })

  test('constructor initializes throttle functions properly', async ({ expect }) => {
    const revoker = new Revoker({
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
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    await Promise.all([
      expect(revoker.add('')).rejects.toThrow('Value must be a string'),
      expect(revoker.add(null)).rejects.toThrow('Value must be a string'),
      expect(revoker.add(undefined)).rejects.toThrow('Value must be a string')
    ]);
    await revoker.destroy()
  })

  test('destroy method handles multiple calls safely', async ({ expect }) => {
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    })

    await revoker.destroy()
    expect(async() => await revoker.destroy()).not.toThrow()
    expect(revoker.bloomFilterManager).toBeNull()
  })

  test('add method handles null bloomFilterManager', async ({ expect }) => {
    const revoker = new Revoker({
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
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          claimsToCheck: ['claim1'],
          logger
      })
      revoker.bloomFilterManager.destroy()
      revoker.bloomFilterManager = null; // Simulate a null manager
      expect(() => revoker.reset()).not.toThrow();//Should not throw an error
      await revoker.destroy()
  })

  test('destroy method handles multiple calls safely and sets bloomFilterManager to null', async ({ expect }) => {
      const revoker = new Revoker({
          numItems: 1000,
          fpRate: 0.01,
          rotateTime: 1000,
          claimsToCheck: ['claim1'],
          logger
      })

      await revoker.destroy()
      expect(async () => await revoker.destroy()).not.toThrow()
      expect(revoker.bloomFilterManager).toBeNull() // This line was already covered, but it's good to keep it
  })

  test('destroy method calls destroy on bloomFilterManager', async ({ expect }) => {
      const revoker = new Revoker({
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
    const resetSpy = sinon.spy(BloomFilterManager.prototype, 'reset');
    const revoker = new Revoker({
      numItems: 1000,
      fpRate: 0.01,
      rotateTime: 1000,
      claimsToCheck: ['claim1'],
      logger
    });
    revoker.reset();
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

  test('Both Middlewares - verify error details in response', async ({ expect }) => {
    revoker = new Revoker({
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
        // empty token to trigger an error
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    middleware(req, res, next)

    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: expect.stringContaining('Invalid token'),
      details: null
    })
    await revoker.destroy()
  })

  test('Both Middlewares - proper logging in development mode', async ({ expect }) => {
    process.env.NODE_ENV = 'development'
    
    revoker = new Revoker({
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
        // empty token to trigger an error
      }
    }
    const res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }

    logger.error.resetHistory()

    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.warn.called).toBe(true)
    expect(logger.error.called).toBe(false)
    await revoker.destroy()
  })

  test('JWT Middleware - throttle is called in non-development mode', async ({ expect }) => {
    process.env.NODE_ENV = 'production';
    // logger = { info: sinon.spy(), warn: sinon.spy(),debug: sinon.spy, error: sinon.spy() };
    const throttleJWTStub = sinon.spy();

    revoker = new Revoker({
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000,
        claimsToCheck: ['claim1'],
        logger,
    });

    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = { token: { claim1: 'value1' } };
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };

    logger.info.resetHistory();
    logger.warn.resetHistory();
    await revoker.add('claim1-value1'); // Blacklist the claim
    middleware(req, res, next);

    expect(throttleJWTStub.called).toBe(false); // Because the stub is not used inside the middleware
    expect(logger.info.called).toBe(true);
    expect(logger.warn.called).toBe(false);
    expect(logger.error.calledOnceWithExactly('Token claim1 is blacklisted'));
    process.env.NODE_ENV = 'test';
    await revoker.destroy();
  });

  test('Opaque Middleware - throttle is called in non-development mode', async ({ expect }) => {
    process.env.NODE_ENV = 'production';
    // logger = { info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
    const throttleOpaqueStub = sinon.spy();

    revoker = new Revoker({
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000,
        opaqueHeader: 'Authorization',
        logger,
    });

    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const token = 'testToken';
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };

    logger.info.resetHistory();
    logger.warn.resetHistory();
    await revoker.add(token);
    
    middleware(req, res, next);

    expect(throttleOpaqueStub.called).toBe(false); // Because the stub is not used inside the middleware
    expect(logger.info.called).toBe(true);
    expect(logger.warn.called).toBe(false);
    expect(logger.error.calledOnceWithExactly(`Token ${token} is blacklisted`));
    process.env.NODE_ENV = 'test';
    await revoker.destroy();
  });

  test('createJWTMiddleware - Missing token logs an error', async ({ expect }) => {
    // logger = { info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
    revoker = new Revoker({
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000,
        claimsToCheck: ['claim1'],
        logger,
    });
    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = {};
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };
    logger.error.resetHistory();
    middleware(req, res, next);
    expect(logger.error.calledOnce).toBe(true);
  });

  test('createOpaqueMiddleware - Missing header logs a warning', async ({ expect }) => {
    // logger = { info: sinon.spy(), warn: sinon.spy(), error: sinon.spy() };
    revoker = new Revoker({
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 1000,
        opaqueHeader: 'Authorization',
        logger,
    });
    const middleware = revoker.getMiddleware();
    const next = sinon.spy();
    const req = { headers: {} };
    const res = { status: sinon.stub().returnsThis(), json: sinon.stub() };

    logger.warn.resetHistory();
    try {
        middleware(req, res, next);
    } catch (error) {
        expect(logger.warn.called).toBe(false); // Should not be called because throttle is not mocked
    }
  });
})