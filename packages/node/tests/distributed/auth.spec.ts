import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CoordinatorAuthConfig } from '@express-token-revoker/server';
import { type CoordinatorHandle, createCoordinator } from '@express-token-revoker/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoordinatorClient,
  createRevokerNode,
  type RevokerNode,
  type RevokerNodeConfig,
} from '../../src/index.js';
import type { NodeAuthConfig } from '../../src/validation.js';
import { fixtures, TEST_SHARED_SECRET } from '../helpers/fixtures.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * PD-1 auth modes end-to-end: REAL coordinator + REAL node over TLS gRPC
 * (loopback, port 0), using the committed static fixtures. Covers:
 * - shared-secret happy path (add + propagate over one-way TLS),
 * - wrong secret => bootstrap rejected with UNAUTHENTICATED,
 * - mtls happy path (client cert) and no-cert rejection at the TLS layer,
 * - insecure mode starts on both sides with the loud startup warning,
 * - node-side auth config validation (incomplete TLS configs refused).
 */

const ROTATE_TIME_MS = 3_600_000; // auto-rotation must never fire inside a test

const sharedSecretServerAuth: CoordinatorAuthConfig = {
  mode: 'shared-secret',
  secret: TEST_SHARED_SECRET,
  caCertPath: fixtures.caCertPath,
  serverCertPath: fixtures.serverCertPath,
  serverKeyPath: fixtures.serverKeyPath,
};

const mtlsServerAuth: CoordinatorAuthConfig = {
  ...sharedSecretServerAuth,
  mode: 'mtls',
};

const sharedSecretNodeAuth: NodeAuthConfig = {
  mode: 'shared-secret',
  secret: TEST_SHARED_SECRET,
  caCertPath: fixtures.caCertPath,
};

describe('Node auth (PD-1, TLS fixtures, real coordinator)', () => {
  const handles: CoordinatorHandle[] = [];
  const nodes: RevokerNode[] = [];
  const tempDirs: string[] = [];

  const makeDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  const startCoordinator = async (
    auth: CoordinatorAuthConfig,
    logger = createMockLogger()
  ): Promise<CoordinatorHandle> => {
    const handle = await createCoordinator({
      id: 'coord-auth-test',
      logger,
      port: 0,
      backupDir: makeDir('etr-auth-coord-'),
      opaqueHeader: 'Authorization',
      auth,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: ROTATE_TIME_MS,
        backupRatioTime: 2,
      },
    });
    handles.push(handle);
    return handle;
  };

  const nodeConfig = (
    handle: CoordinatorHandle,
    auth: NodeAuthConfig,
    logger = createMockLogger()
  ): RevokerNodeConfig =>
    ({
      nodeId: 'node-auth',
      // Hostname target: grpc-js derives the TLS SNI servername from the
      // authority and Node rejects IP literals there; the fixture cert's
      // SAN covers DNS:localhost.
      coordinatorAddress: `localhost:${handle.port}`,
      logger,
      backupDir: makeDir('etr-auth-node-'),
      opaqueHeader: 'Authorization',
      auth,
      pollIntervalMs: 200,
      safetyFactor: 2,
      filter: {
        numItems: 1000,
        fpRate: 0.0001,
        rotateTime: ROTATE_TIME_MS,
      },
    }) as RevokerNodeConfig;

  afterEach(async () => {
    for (const node of nodes.splice(0)) {
      try {
        await node.shutdown();
      } catch {
        // best effort
      }
    }
    for (const handle of handles.splice(0)) {
      try {
        await handle.shutdown();
      } catch {
        // best effort
      }
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shared-secret happy path: node bootstraps and revocations propagate over TLS', async () => {
    const handle = await startCoordinator(sharedSecretServerAuth);
    handle.coordinator.add('pre-token');

    const node = await createRevokerNode(nodeConfig(handle, sharedSecretNodeAuth));
    nodes.push(node);

    // Bootstrap (GetSnapshot over one-way TLS + secret metadata) applied the
    // pre-existing entry; wait for the backlog drain.
    await vi.waitFor(() => expect(node.has('pre-token')).toBe(true), { timeout: 5000 });

    // Live propagation over the authenticated Subscribe stream.
    handle.coordinator.add('live-token');
    await vi.waitFor(() => expect(node.has('live-token')).toBe(true), { timeout: 5000 });
    expect(node.has('never-revoked')).toBe(false);
    expect(node.healthCheck().checks.sync.connected).toBe(true);
  });

  it('wrong secret: the node is rejected with UNAUTHENTICATED and never joins', async () => {
    const handle = await startCoordinator(sharedSecretServerAuth);

    const config = nodeConfig(handle, {
      ...sharedSecretNodeAuth,
      secret: 'wrong-secret-0123456789',
    });
    await expect(createRevokerNode(config)).rejects.toMatchObject({ code: 16 }); // UNAUTHENTICATED
  });

  it('mtls happy path: node WITH a client certificate works end-to-end', async () => {
    const handle = await startCoordinator(mtlsServerAuth);

    const node = await createRevokerNode(
      nodeConfig(handle, {
        ...sharedSecretNodeAuth,
        mode: 'mtls',
        clientCertPath: fixtures.client1CertPath,
        clientKeyPath: fixtures.client1KeyPath,
      })
    );
    nodes.push(node);

    handle.coordinator.add('mtls-live');
    await vi.waitFor(() => expect(node.has('mtls-live')).toBe(true), { timeout: 5000 });
    expect(node.healthCheck().checks.sync.connected).toBe(true);
  });

  it('mtls: a node WITHOUT a client certificate is rejected at the TLS layer', async () => {
    const handle = await startCoordinator(mtlsServerAuth);

    // One-way TLS only (CA + correct secret, no client cert) — the server
    // demands a client certificate, so the handshake dies and bootstrap
    // can never complete. The DI seam builds the same real client with a
    // shorter connect deadline to keep the test fast.
    const config = nodeConfig(handle, sharedSecretNodeAuth);
    await expect(
      createRevokerNode(config, {
        createClient: (options) => new CoordinatorClient({ ...options, connectTimeoutMs: 3000 }),
      })
    ).rejects.toThrow(/certificate|Failed to connect/i);
  }, 20_000);

  it('insecure mode: both sides start and log the loud warning', async () => {
    const coordLogger = createMockLogger();
    const handle = await startCoordinator({ mode: 'insecure' }, coordLogger);
    expect(coordLogger.warn.mock.calls.flat().join(' ')).toMatch(/INSECURE MODE/);

    const nodeLogger = createMockLogger();
    const node = await createRevokerNode(nodeConfig(handle, { mode: 'insecure' }, nodeLogger));
    nodes.push(node);

    expect(nodeLogger.warn.mock.calls.flat().join(' ')).toMatch(/INSECURE MODE/);
    // The insecure link still replicates (dev mode must work).
    handle.coordinator.add('insecure-token');
    await vi.waitFor(() => expect(node.has('insecure-token')).toBe(true), { timeout: 5000 });
  });

  it('node auth config validation: incomplete TLS configs are refused before any I/O', async () => {
    const handle = await startCoordinator(sharedSecretServerAuth);

    // Missing secret.
    await expect(
      createRevokerNode(
        nodeConfig(handle, { mode: 'shared-secret', caCertPath: fixtures.caCertPath })
      )
    ).rejects.toThrow(/Invalid node config/);

    // Secret shorter than 16 chars.
    await expect(
      createRevokerNode(nodeConfig(handle, { ...sharedSecretNodeAuth, secret: 'short' }))
    ).rejects.toThrow(/Invalid node config/);

    // mtls without the client keypair.
    await expect(
      createRevokerNode(nodeConfig(handle, { ...sharedSecretNodeAuth, mode: 'mtls' }))
    ).rejects.toThrow(/Invalid node config/);
  });
});
