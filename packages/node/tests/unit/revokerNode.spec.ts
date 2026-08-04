import { describe, it, expect } from 'vitest';
import { createRevokerNode } from '../../src/index.js';
import type { RevokerNodeConfig } from '../../src/validation.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * Validation matrix for createRevokerNode. Joi validation runs BEFORE any
 * I/O or network, so every invalid config rejects synchronously with a
 * ValidationError — no coordinator needed.
 */

function baseConfig(overrides: Partial<RevokerNodeConfig> = {}): RevokerNodeConfig {
  return {
    nodeId: 'node-a',
    coordinatorAddress: '127.0.0.1:50100',
    logger: createMockLogger(),
    backupDir: '/tmp/etr-node-validation-matrix',
    opaqueHeader: 'Authorization',
    filter: {
      numItems: 1000,
      fpRate: 0.0001,
      rotateTime: 600_000,
    },
    ...overrides,
  } as RevokerNodeConfig;
}

/** Test helper: mutate/delete fields the typed config forbids. */
function asRecord(config: RevokerNodeConfig): Record<string, unknown> {
  return config as unknown as Record<string, unknown>;
}

function asConfig(record: Record<string, unknown>): RevokerNodeConfig {
  return record as unknown as RevokerNodeConfig;
}

describe('createRevokerNode config validation', () => {
  it('rejects a missing nodeId', async () => {
    const record = asRecord(baseConfig());
    delete record.nodeId;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
  });

  it('rejects a nodeId outside the id pattern (path-traversal guard)', async () => {
    await expect(createRevokerNode(baseConfig({ nodeId: '../evil' }))).rejects.toThrow(
      /Invalid node config/
    );
    await expect(createRevokerNode(baseConfig({ nodeId: 'has space' }))).rejects.toThrow(
      /Invalid node config/
    );
  });

  it('rejects a missing/too-short coordinatorAddress', async () => {
    const record = asRecord(baseConfig());
    delete record.coordinatorAddress;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
    await expect(createRevokerNode(baseConfig({ coordinatorAddress: 'ab' }))).rejects.toThrow(
      /Invalid node config/
    );
  });

  it('rejects a missing backupDir', async () => {
    const record = asRecord(baseConfig());
    delete record.backupDir;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
  });

  it('rejects claimsToCheck and opaqueHeader together (xor)', async () => {
    await expect(
      createRevokerNode(
        baseConfig({ claimsToCheck: ['jti'], payloadKey: 'token' }) as RevokerNodeConfig
      )
    ).rejects.toThrow(/Invalid node config/);
  });

  it('rejects neither claimsToCheck nor opaqueHeader (xor)', async () => {
    const record = asRecord(baseConfig());
    delete record.opaqueHeader;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
  });

  it('rejects claimsToCheck without payloadKey', async () => {
    const record = asRecord(baseConfig({ claimsToCheck: ['jti'] }));
    delete record.opaqueHeader;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
  });

  it('rejects fpRate outside the exclusive (0,1) range', async () => {
    await expect(
      createRevokerNode(baseConfig({ filter: { numItems: 1000, fpRate: 1, rotateTime: 1000 } }))
    ).rejects.toThrow(/Invalid node config/);
    await expect(
      createRevokerNode(baseConfig({ filter: { numItems: 1000, fpRate: 0, rotateTime: 1000 } }))
    ).rejects.toThrow(/Invalid node config/);
  });

  it('rejects numItems below 1', async () => {
    await expect(
      createRevokerNode(
        baseConfig({ filter: { numItems: 0, fpRate: 0.0001, rotateTime: 1000 } })
      )
    ).rejects.toThrow(/Invalid node config/);
  });

  it('rejects a non-positive rotateTime', async () => {
    await expect(
      createRevokerNode(
        baseConfig({ filter: { numItems: 1000, fpRate: 0.0001, rotateTime: -5 } })
      )
    ).rejects.toThrow(/Invalid node config/);
  });

  it('rejects safetyFactor below 2', async () => {
    await expect(createRevokerNode(baseConfig({ safetyFactor: 1.5 }))).rejects.toThrow(
      /Invalid node config/
    );
  });

  it('rejects pollIntervalMs below 100', async () => {
    await expect(createRevokerNode(baseConfig({ pollIntervalMs: 50 }))).rejects.toThrow(
      /Invalid node config/
    );
  });

  it('rejects unknown config keys', async () => {
    const record = asRecord(baseConfig());
    record.surprise = true;
    await expect(createRevokerNode(asConfig(record))).rejects.toThrow(/Invalid node config/);
  });
});
