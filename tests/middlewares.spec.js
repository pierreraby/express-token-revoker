import { test } from '@japa/runner'
import sinon from 'sinon'
import throttle from "throttleit";
import { BloomFilterManager } from '../dist/Bloom-filter-manager.js'
import { createJWTMiddleware, createOpaqueMiddleware } from '#dist/createMiddlewares.js'

test.group('Middleware Tests', (group) => {  
  let logger
  let req
  let res
  let next
  let manager

  const throttleLog = throttle((message) => logger.info(message), 10);

  group.each.setup(() => {
    process.env.NODE_ENV = 'test'
    logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      debug: sinon.spy(),
      error: sinon.spy()
    }

    manager = new BloomFilterManager({
      id: 'test',
      logger,
      numItems: 2000,
      fpRate: 0.0001,
      rotateTime: 1000
    })

    
    req = {}
    res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub()
    }
    next = sinon.spy()
  })

  group.each.teardown(async () => {
    sinon.restore() // Restore all Sinon stubs, fakes, and mocks.
    await manager.resetAndClearData();
    manager.destroy();
  })



  test('JWT Middleware - if in development mode, logger is called', ({ expect }) => {
    process.env.NODE_ENV = 'development'

    const middleware = createJWTMiddleware(['claim1'], 'token', manager, logger, throttleLog);
    const req = {
      token: {
        claim: 'value'
      }
    }

    manager.add('claim-value') // Blacklist the claim
    middleware(req, res, next)

    expect(logger.info.called).toBe(true)
    expect(logger.warn.called).toBe(true)
    expect(logger.error.called).toBe(false)
  })

  test('JWT Middleware - missing payload', ({ expect }) => {
    const middleware = createJWTMiddleware(['claim1', 'claim2'], 'token', manager, logger, throttleLog);
    const req = {}
    
    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing JWT payload in request'
    })
  })

  test('JWT Middleware - missing required claim', ({ expect }) => {
    const middleware = createJWTMiddleware(['claim1', 'claim2'], 'token', manager, logger, throttleLog);
    req = {
      token: {
        claim1: 'value1'
      }
    }
    
    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing claim2 claim in JWT Payload'
    })
  })

  test('JWT Middleware - valid token with all required claims', ({ expect }) => {
    const middleware = createJWTMiddleware(['claim1', 'claim2'], 'token', manager, logger, throttleLog);
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }
    middleware(req, res, next)

    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
  })

  test('JWT Middleware - valid token with all required claims and blacklisted claim', ({ expect }) => {
    const middleware = createJWTMiddleware(['claim1', 'claim2'], 'token', manager, logger, throttleLog);
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2'
      }
    }
    manager.add('claim1-value1') // Blacklist the claim

    middleware(req, res, next)

    expect(next.called).toBe(false)
    expect(res.status.calledWith(401)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'invalid_token',
      message: 'Invalid token!'
    })
  })

  test('JWT Middleware - log internal error', ({ expect }) => {
    const middleware = createJWTMiddleware(['claim1', 'claim2'], 'token', manager, logger, throttleLog);

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
  })

  test('Opaque Middleware - if in development mode, logger is called', ({ expect }) => {
    process.env.NODE_ENV = 'development'

    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

    const req = {
      headers: {
        authorization
        : 'Bearer validToken'
      }
    }

    manager.add('validToken') // Blacklist le token
    middleware(req, res, next)

    expect(logger.warn.called).toBe(false)
    expect(logger.error.called).toBe(false)
  })

  test('Opaque Middleware - valid Authorization header', ({ expect }) => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    req = {
      headers: {
        authorization: 'Bearer validToken'
      }
    }

    middleware(req, res, next)

    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
  })

  test('Opaque Middleware - missing Authorization header', ({ expect }) => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    
    req = {
      headers: {}
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Missing header: Authorization')
    }

    expect(next.called).toBe(false)
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing header: authorization'
    })
  })

  test('Opaque Middleware - invalid Authorization header format', ({ expect }) => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
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
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'validation_error',
      message: 'Invalid authorization header format. Expected "Bearer <token>"'
    })
  })

  test('Opaque Middleware - blacklisted token', ({ expect }) => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    
    const token = 'validToken'
    manager.add(token) // Blacklist le token
    
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
  })

  test('Opaque Middleware - custom header validation', ({ expect }) => {
    const middleware = createOpaqueMiddleware('X-Custom-Token', manager, logger, throttleLog);
    req = {
      headers: {
        'x-custom-token': 'validToken'
      }
    }

    middleware(req, res, next)

    expect(next.calledOnce).toBe(true)
    expect(res.status.called).toBe(false)
    expect(res.json.called).toBe(false)
  })

  test('Opaque Middleware - Missing custom header', ({ expect }) => {
    const middleware = createOpaqueMiddleware('X-Custom-Token', manager, logger, throttleLog);
    req = {
      headers: {}
    }

    try {
      middleware(req, res, next)
    } catch (error) {
      expect(error.message).toBe('Missing header: X-Custom-Token')
    }

    expect(next.called).toBe(false)
    expect(res.status.calledWith(400)).toBe(true)
    expect(res.json.calledOnce).toBe(true)
    expect(res.json.firstCall.args[0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing header: x-custom-token'
    })
  })

  test('Opaque Middleware - log internal error', ({ expect }) => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

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
  })
})