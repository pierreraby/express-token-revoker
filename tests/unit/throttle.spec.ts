import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logOrThrottle } from '../../dist/throttle.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

describe('Throttle Tests', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NODE_ENV = 'test';
  });

  it('logOrThrottle logs in development mode', () => {
    process.env.NODE_ENV = 'development';
    const throttleStub = vi.fn();

    logOrThrottle('test message', throttleStub, logger);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('test message');
    expect(throttleStub).not.toHaveBeenCalled();
  });

  it('logOrThrottle throttles in non-development mode', () => {
    process.env.NODE_ENV = 'production';
    const throttleStub = vi.fn();

    logOrThrottle('test message', throttleStub, logger);

    expect(logger.info).not.toHaveBeenCalled();
    expect(throttleStub).toHaveBeenCalled();
  });

  it('logOrThrottle logs error when throttleFn throws', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('Throttle error');
    const throttleStub = vi.fn().mockImplementation(() => {
      throw error;
    });

    logOrThrottle('test message', throttleStub, logger);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Error in logOrThrottle:');
    expect(logger.error.mock.calls[0][1]).toEqual(error);
  });

  it('logOrThrottle logs warning in development mode for error messages', () => {
    process.env.NODE_ENV = 'development';
    const throttleStub = vi.fn();

    logOrThrottle('error message', throttleStub, logger, true);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('error message');
    expect(throttleStub).not.toHaveBeenCalled();
  });
});
