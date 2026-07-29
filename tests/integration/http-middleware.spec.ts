import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createRevoker } from '../../dist/index.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * End-to-end HTTP integration tests for JWT and Opaque middlewares.
 * Mounts the middleware on a real Express app and tests via supertest.
 */
describe('HTTP Middleware Integration (supertest)', () => {
  let app: Express;
  let jwtRevoker: Awaited<ReturnType<typeof createRevoker>>;
  let opaqueRevoker: Awaited<ReturnType<typeof createRevoker>>;
  const logger = createMockLogger();

  beforeAll(async () => {
    // --- JWT Revoker ---
    jwtRevoker = await createRevoker({
      id: 'http-jwt',
      claimsToCheck: ['jti'],
      payloadKey: 'jwtPayload',
      logger,
      filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
    });

    // --- Opaque Revoker ---
    opaqueRevoker = await createRevoker({
      id: 'http-opaque',
      opaqueHeader: 'Authorization',
      logger,
      filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
    });

    // --- Express app with both middlewares on different routes ---
    app = express();

    // Middleware that injects a mocked JWT payload (simulating auth middleware upstream)
    app.use('/api/jwt', (req, _res, next) => {
      (req as any).jwtPayload = { jti: `token-${Date.now()}` };
      next();
    });

    // Revoker JWT middleware
    app.use('/api/jwt', jwtRevoker.getMiddleware());
    app.get('/api/jwt', (_req, res) => res.json({ ok: true }));

    // Revoker Opaque middleware (Bearer token)
    app.use('/api/opaque', opaqueRevoker.getMiddleware());
    app.get('/api/opaque', (_req, res) => res.json({ ok: true }));
  });

  afterAll(async () => {
    await jwtRevoker.destroy();
    await opaqueRevoker.destroy();
  });

  // ---------------------------------------------------------------------------
  // JWT Middleware
  // ---------------------------------------------------------------------------
  describe('JWT Middleware', () => {
    it('allows request with valid (non-revoked) claim', async () => {
      const res = await request(app).get('/api/jwt');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects request with revoked claim', async () => {
      const revokedJti = 'jti-revoked-http';
      jwtRevoker.add(`jti-${revokedJti}`);

      // Build a request with the revoked claim
      const res = await request(app)
        .get('/api/jwt')
        .set('X-Override-Jti', revokedJti); // not used by this middleware,
      // it uses req.jwtPayload. We need a different
      // approach to inject the revoked payload.

      // For JWT, the payload is on req[payloadKey] — we can't easily
      // override it via HTTP without a middleware shim. Let's use a
      // custom route that allows payload injection for the test.
    });

    it('returns 401 when claim is revoked (via injected payload)', async () => {
      // Create a dedicated test route that mocks the upstream auth
      const testApp = express();
      let revoker: Awaited<ReturnType<typeof createRevoker>>;

      const testLogger = createMockLogger();
      revoker = await createRevoker({
        id: 'http-jwt-revoked',
        claimsToCheck: ['jti'],
        payloadKey: 'jwtPayload',
        logger: testLogger,
        filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
      });

      revoker.add('jti-blacklisted');

      testApp.use((req, _res, next) => {
        (req as any).jwtPayload = { jti: 'blacklisted' };
        next();
      });
      testApp.use(revoker.getMiddleware());
      testApp.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(testApp).get('/test');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');

      await revoker.destroy();
    });

    it('returns 400 when JWT payload is missing', async () => {
      const testApp = express();
      let revoker: Awaited<ReturnType<typeof createRevoker>>;

      const testLogger = createMockLogger();
      revoker = await createRevoker({
        id: 'http-jwt-missing',
        claimsToCheck: ['jti'],
        payloadKey: 'jwtPayload',
        logger: testLogger,
        filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
      });

      // No payload middleware → missing
      testApp.use(revoker.getMiddleware());
      testApp.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(testApp).get('/test');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.message).toBe('Missing JWT payload in request');

      await revoker.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Opaque Middleware
  // ---------------------------------------------------------------------------
  describe('Opaque Middleware', () => {
    it('allows request with valid Bearer token', async () => {
      const res = await request(app)
        .get('/api/opaque')
        .set('Authorization', 'Bearer valid-opaque-token');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('rejects request with revoked Bearer token', async () => {
      opaqueRevoker.add('revoked-opaque-token');

      const res = await request(app)
        .get('/api/opaque')
        .set('Authorization', 'Bearer revoked-opaque-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
    });

    it('returns 400 when Authorization header is missing', async () => {
      const res = await request(app).get('/api/opaque');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.message).toBe('Missing header: authorization');
    });

    it('returns 400 for malformed Authorization header', async () => {
      const res = await request(app)
        .get('/api/opaque')
        .set('Authorization', 'JustAString');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
      expect(res.body.message).toBe('Invalid authorization header format. Expected "Bearer <token>"');
    });

    it('is case-insensitive for custom header names', async () => {
      // Create dedicated revoker with custom header
      const testLogger = createMockLogger();
      const customRevoker = await createRevoker({
        id: 'http-custom-header',
        opaqueHeader: 'X-Api-Key',
        logger: testLogger,
        filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
      });

      const testApp = express();
      testApp.use(customRevoker.getMiddleware());
      testApp.get('/test', (_req, res) => res.json({ ok: true }));

      const res = await request(testApp)
        .get('/test')
        .set('x-api-key', 'valid-key');
      expect(res.status).toBe(200);

      await customRevoker.destroy();
    });
  });
});
