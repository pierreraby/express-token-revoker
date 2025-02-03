import { test } from '@japa/runner'
import sinon from 'sinon'
import { logOrThrottle } from '#dist/throttle.js'

test.group('Throttle Tests', (group) => { 
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
    sinon.restore();
    process.env.NODE_ENV = 'test'
  })

  test('logOrThrottle logs in development mode', async ({ expect }) => {
    process.env.NODE_ENV = 'development'
    const throttleStub = sinon.stub().returns(() => {})

    logOrThrottle('test message', throttleStub, logger)

    expect(logger.info.calledOnceWithExactly('test message')).toBe(true)
    expect(throttleStub.called).toBe(false)
    
  })

  test('logOrThrottle throttles in non-development mode', async ({ expect }) => {
    process.env.NODE_ENV = 'production'
    const throttleStub = sinon.stub().returns(() => {})

    logOrThrottle('test message', throttleStub, logger)

    expect(logger.info.calledOnceWithExactly('test message')).toBe(false)
    expect(throttleStub.called).toBe(true)
  })

  test('logOrThrottle logs error when throttleFn throws', async ({ expect }) => {
    process.env.NODE_ENV = 'production'
    const error = new Error('Throttle error')
    const throttleStub = sinon.stub().throws(error)

    logOrThrottle('test message', throttleStub, logger)

    expect(logger.error.calledOnce).toBe(true)
    expect(logger.error.firstCall.args[0]).toBe('Error in logOrThrottle:')
    expect(logger.error.firstCall.args[1]).toEqual(error)
  })

  test('logOrThrottle logs warning in development mode for error messages', async ({ expect }) => {
    process.env.NODE_ENV = 'development'
    const throttleStub = sinon.stub().returns(() => {})

    logOrThrottle('error message', throttleStub, logger, true)

    expect(logger.warn.calledOnceWithExactly('error message')).toBe(true)
    expect(throttleStub.called).toBe(false)
  })
})