import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRevokerClientAsync } from '../../src/grpc/std-client-async.js';
import { createRevoker } from '../../src/index.js';

const TEST_PORT = 50052;
const SERVER_ADDRESS = `127.0.0.1:${TEST_PORT}`;

describe('gRPC Server Integration Tests', () => {
  let logger: { info: (...args: any[]) => void; error: (...args: any[]) => void; warn: (...args: any[]) => void; debug: (...args: any[]) => void };
  let jwtRevoker: any;
  let opaqueRevoker: any;
  let client: any;

  beforeAll(async () => {
    logger = {
      info: (...args: any[]) => console.log(...args),
      error: (...args: any[]) => console.error(...args),
      warn: (...args: any[]) => console.warn(...args),
      debug: (...args: any[]) => console.debug(...args),
    };

    jwtRevoker = await createRevoker({
      id: 'JWTrevoker',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: 10000,
        backup: true,
        backupRatioTime: 2,
      },
      grpcEnabled: true,
      grpcPort: TEST_PORT,
    });

    opaqueRevoker = await createRevoker({
      id: 'opaqueRevoker',
      opaqueHeader: 'Authorization',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: 10000,
        backup: true,
      },
      grpcEnabled: true,
      grpcPort: TEST_PORT,
    });

    client = createRevokerClientAsync(SERVER_ADDRESS);
  });

  afterAll(async () => {
    client.close();
    await jwtRevoker.destroy();
    await opaqueRevoker.destroy();
  });

  it('end-to-end scenario with JWT Revoker', async () => {
    const item = 'item1';

    const listResponse = await client.ListRevokers({});
    expect(listResponse.revokerIds).toContain('JWTrevoker');

    const addResponse = await client.add({ revokerId: 'JWTrevoker', item });
    expect(addResponse.success).toBe(true);

    const hasResponse = await client.has({ revokerId: 'JWTrevoker', item });
    expect(hasResponse.exists).toBe(true);

    const metricsResponse = await client.getMetrics({ revokerId: 'JWTrevoker' });
    expect(metricsResponse.estimatedMetrics).toBeTruthy();
    expect(metricsResponse.configuration).toBeTruthy();
    // Proto/server field alignment: backupRatioTime must round-trip (was silently
    // dropped when the proto declared it as backupTime).
    expect(metricsResponse.configuration.backupRatioTime).toBe(2);

    const resetRestoreResponse = await client.resetAndRestore({ revokerId: 'JWTrevoker' });
    expect(resetRestoreResponse.success).toBe(true);

    const hasResponse2 = await client.has({ revokerId: 'JWTrevoker', item });
    expect(hasResponse2.exists).toBe(true); // Should be true after resetAndRestore

    const resetClearDataResponse = await client.resetAndClearData({ revokerId: 'JWTrevoker' });
    expect(resetClearDataResponse.success).toBe(true);

    const hasResponse3 = await client.has({ revokerId: 'JWTrevoker', item });
    expect(hasResponse3.exists).toBe(false); // Should be false after resetAndClearData
  });

  it('end-to-end scenario with Opaque Revoker', async () => {
    const item = 'item2';

    const listResponse = await client.ListRevokers({});
    expect(listResponse.revokerIds).toContain('opaqueRevoker');

    const addResponse = await client.add({ revokerId: 'opaqueRevoker', item });
    expect(addResponse.success).toBe(true);

    const hasResponse1 = await client.has({ revokerId: 'opaqueRevoker', item });
    expect(hasResponse1.exists).toBe(true);

    const metricsResponse = await client.getMetrics({ revokerId: 'opaqueRevoker' });
    expect(metricsResponse.estimatedMetrics).toBeTruthy();
    expect(metricsResponse.configuration).toBeTruthy();

    const resetRestoreResponse = await client.resetAndRestore({ revokerId: 'opaqueRevoker' });
    expect(resetRestoreResponse.success).toBe(true);

    const hasResponse2 = await client.has({ revokerId: 'opaqueRevoker', item });
    expect(hasResponse2.exists).toBe(true); // Devrait être true après resetAndRestore

    const resetClearDataResponse = await client.resetAndClearData({ revokerId: 'opaqueRevoker' });
    expect(resetClearDataResponse.success).toBe(true);

    const hasResponse3 = await client.has({ revokerId: 'opaqueRevoker', item });
    expect(hasResponse3.exists).toBe(false); // Devrait être false après resetAndClearData
  });

  it('returns error if revoker not found', async () => {
    await expect(client.add({ revokerId: 'unknownRevoker', item: 'item1' })).rejects.toThrow(
      'Revoker instance or Bloom filter not found'
    );
  });

  it('rejects invalid items with INVALID_ARGUMENT', async () => {
    // Empty item
    await expect(client.add({ revokerId: 'JWTrevoker', item: '' })).rejects.toThrow(
      'item must be a non-empty string'
    );
    // Line breaks would poison the write-ahead log
    await expect(client.add({ revokerId: 'JWTrevoker', item: 'evil\njti-1' })).rejects.toThrow(
      'item must not contain'
    );
    await expect(client.has({ revokerId: 'JWTrevoker', item: 'evil\r\nvalue' })).rejects.toThrow(
      'item must not contain'
    );
    // Oversized item (hard cap against CPU/hash DoS)
    await expect(
      client.add({ revokerId: 'JWTrevoker', item: 'x'.repeat(5000) })
    ).rejects.toThrow('item must not exceed 4096 characters');
  });
});
