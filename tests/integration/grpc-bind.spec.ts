import { describe, it, expect, afterAll } from 'vitest';
import net from 'node:net';
import { createRevoker } from '../../src/index.js';
import { createRevokerClientAsync } from '../../src/grpc/std-client-async.js';

const BIND_TEST_PORT = 50061;

const logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

const baseConfig = (port: number, extra: Record<string, unknown> = {}) => ({
  id: 'bind-test',
  claimsToCheck: ['claim1'],
  payloadKey: 'token',
  logger,
  filter: { numItems: 1000, fpRate: 0.0001, rotateTime: 60000 },
  grpcEnabled: true,
  grpcPort: port,
  ...extra,
});

/** Occupies a TCP port until closed. */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const dummy = net.createServer();
    dummy.once('error', reject);
    dummy.listen(port, '127.0.0.1', () => resolve(dummy));
  });
}

describe('gRPC bind safety', () => {
  let revoker: any;

  afterAll(async () => {
    if (revoker) {
      await revoker.destroy();
    }
  });

  it('refuses to bind a non-loopback host without TLS', async () => {
    await expect(createRevoker(baseConfig(BIND_TEST_PORT, { grpcHost: '0.0.0.0' }))).rejects.toThrow(
      'Refusing to bind the unauthenticated gRPC admin service to non-loopback host'
    );
  });

  it('recovers after a failed bind (port in use) — the store is not poisoned', async () => {
    const dummy = await occupyPort(BIND_TEST_PORT);

    // First attempt: the port is taken → the bind fails
    await expect(createRevoker(baseConfig(BIND_TEST_PORT))).rejects.toThrow(
      'Failed to start gRPC server'
    );

    dummy.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second attempt: the port is free → must succeed instead of failing
    // forever with "Revoker instances map is already initialized"
    revoker = await createRevoker(baseConfig(BIND_TEST_PORT));
    expect(revoker).toBeTruthy();

    const client = createRevokerClientAsync(`127.0.0.1:${BIND_TEST_PORT}`);
    const addResponse = await client.add({ revokerId: 'bind-test', item: 'item-1' });
    expect(addResponse.success).toBe(true);
    const hasResponse = await client.has({ revokerId: 'bind-test', item: 'item-1' });
    expect(hasResponse.exists).toBe(true);
    client.close();
  });

  it('accepts a non-loopback bind with the explicit insecure opt-in', async () => {
    // Destroy the previous instance so the singleton server is stopped
    await revoker.destroy();
    revoker = null;

    revoker = await createRevoker(
      baseConfig(BIND_TEST_PORT, { grpcHost: '0.0.0.0', grpcAllowInsecureRemote: true })
    );
    expect(revoker).toBeTruthy();
  });
});
