import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js';
import { createJWTMiddleware, createOpaqueMiddleware } from '../../dist/createMiddlewares.js';
import throttle from 'throttleit';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';

describe('Middleware Tests', () => {
  let logger: MockLogger;
  let req: Record<string, any>;
  let res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  let next: ReturnType<typeof vi.fn>;
  let manager: BloomFilterManager;
  let throttleLog: (message: string) => void;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    logger = createMockLogger();
    throttleLog = throttle((message: string) => logger.info(message), 10);

    manager = new BloomFilterManager({
      id: 'test',
      logger,
      numItems: 2000,
      fpRate: 0.0001,
      rotateTime: 1000,
    });

    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    next = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.resetAndClearData();
    manager.destroy();
  });

  it('JWT Middleware - if in development mode, logger is called', () => {
    process.env.NODE_ENV = 'development';

    const middleware = createJWTMiddleware(
      ['claim1'],
      'token',
      manager,
      logger,
      throttleLog
    );
    const req = {
      token: {
        claim: 'value',
      },
    };

    manager.add('claim-value'); // Blacklist the claim
    middleware(req as any, res as any, next as any);

    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('JWT Middleware - missing payload', () => {
    const middleware = createJWTMiddleware(
      ['claim1', 'claim2'],
      'token',
      manager,
      logger,
      throttleLog
    );
    const req = {};

    middleware(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing JWT payload in request',
    });
  });

  it('JWT Middleware - missing required claim', () => {
    const middleware = createJWTMiddleware(
      ['claim1', 'claim2'],
      'token',
      manager,
      logger,
      throttleLog
    );
    req = {
      token: {
        claim1: 'value1',
      },
    };

    middleware(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing claim2 claim in JWT Payload',
    });
  });

  it('JWT Middleware - valid token with all required claims', () => {
    const middleware = createJWTMiddleware(
      ['claim1', 'claim2'],
      'token',
      manager,
      logger,
      throttleLog
    );
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2',
      },
    };
    middleware(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('JWT Middleware - valid token with all required claims and blacklisted claim', () => {
    const middleware = createJWTMiddleware(
      ['claim1', 'claim2'],
      'token',
      manager,
      logger,
      throttleLog
    );
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2',
      },
    };
    manager.add('claim1-value1'); // Blacklist the claim

    middleware(req as any, res as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'invalid_token',
      message: 'Invalid token!',
    });
  });

  it('JWT Middleware - log internal error', () => {
    const middleware = createJWTMiddleware(
      ['claim1', 'claim2'],
      'token',
      manager,
      logger,
      throttleLog
    );

    const error = new Error('Internal error');
    const next = vi.fn().mockImplementation(() => {
      throw error;
    });
    req = {
      token: {
        claim1: 'value1',
        claim2: 'value2',
      },
    };

    middleware(req as any, res as any, next as any);

    // NOTE: assertion originale no-op (matcher manquant) — convertie en vérification réelle
    expect(logger.error).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'internal_error',
      message: expect.stringContaining('An unexpected error occurred'),
    });
  });

  it('Opaque Middleware - if in development mode, logger is called', () => {
    process.env.NODE_ENV = 'development';

    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

    const req = {
      headers: {
        authorization: 'Bearer validToken',
      },
    };

    manager.add('validToken'); // Blacklist le token
    middleware(req as any, res as any, next as any);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('Opaque Middleware - valid Authorization header', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    req = {
      headers: {
        authorization: 'Bearer validToken',
      },
    };

    middleware(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('Opaque Middleware - request with multiple Authorization headers', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    req = {
      headers: {
        authorization: ['Bearer validToken', 'Bearer validToken2'],
      },
    };

    middleware(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('Opaque Middleware - request with multiple custom headers', () => {
    const middleware = createOpaqueMiddleware('X-Custom-Token', manager, logger, throttleLog);
    req = {
      headers: {
        'x-custom-token': ['validToken', 'validToken2'],
      },
    };

    middleware(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('Opaque Middleware - missing Authorization header', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

    req = {
      headers: {},
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe('Missing header: Authorization');
    }

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing header: authorization',
    });
  });

  it('Opaque Middleware - invalid Authorization header format', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);
    req = {
      headers: {
        authorization: 'InvalidFormat',
      },
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe('Invalid authorization header');
    }

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'validation_error',
      message: 'Invalid authorization header format. Expected "Bearer <token>"',
    });
  });

  it('Opaque Middleware - blacklisted token', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

    const token = 'validToken';
    manager.add(token); // Blacklist le token

    req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe(`Token ${token} is blacklisted`);
    }

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledOnce();
  });

  it('Opaque Middleware - custom header validation', () => {
    const middleware = createOpaqueMiddleware('X-Custom-Token', manager, logger, throttleLog);
    req = {
      headers: {
        'x-custom-token': 'validToken',
      },
    };

    middleware(req as any, res as any, next as any);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('Opaque Middleware - Missing custom header', () => {
    const middleware = createOpaqueMiddleware('X-Custom-Token', manager, logger, throttleLog);
    req = {
      headers: {},
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe('Missing header: X-Custom-Token');
    }

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'validation_error',
      message: 'Missing header: x-custom-token',
    });
  });

  it('Opaque Middleware - log internal error', () => {
    const middleware = createOpaqueMiddleware('Authorization', manager, logger, throttleLog);

    const error = new Error('Internal error');
    const next = vi.fn().mockImplementation(() => {
      throw error;
    });
    req = {
      headers: {
        authorization: 'Bearer validToken',
      },
    };

    middleware(req as any, res as any, next as any);

    // NOTE: assertion originale no-op (matcher manquant) — convertie en vérification réelle
    expect(logger.error).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledOnce();
    expect(res.json.mock.calls[0][0]).toMatchObject({
      error: 'internal_error',
      message: expect.stringContaining('An unexpected error occurred'),
    });
  });
});
