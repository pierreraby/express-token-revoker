import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { Revoker } from '../../dist/index.js';
import { BloomFilterManager } from '../../dist/Bloom-filter-manager.js';
import RevokerStore from '../../dist/revokerStore.js';
import { createMockLogger, type MockLogger } from '../helpers/mock-logger.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import e from 'express';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import fs from 'fs';

describe('Revoker Constructor Validation Tests', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Constructor throws error if id is not provided', () => {
    expect(
      () =>
        new Revoker({
          claimsToCheck: ['claim1', 'claim2'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "id" is required');
  });

  it('Constructor throws error if id is not a string', () => {
    expect(
      () =>
        new Revoker({
          id: 123 as any,
          claimsToCheck: ['claim1', 'claim2'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "id" must be a string');
  });

  it('Constructor throws error if logger is not provided', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1', 'claim2'],
          payloadKey: 'token',
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "logger" is required');
  });

  it('Constructor throws error if logger is not an object', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          logger: 'logger' as any,
          claimsToCheck: ['claim1', 'claim2'],
          payloadKey: 'token',
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "logger" must be of type object');
  });

  it('Constructor throws error if logger is missing required methods', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
          claimsToCheck: ['claim1', 'claim2'],
          payloadKey: 'token',
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "logger.error" is required');
  });

  it('Constructor throws error if claimsToCheck and opaqueHeader are not provided together', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "claimsToCheck" is required');
  });

  it('Constructor throws error if opaqueHeader and claimsToCheck are provided together', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          opaqueHeader: 'Authorization',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "claimsToCheck" is not allowed');
  });

  it('Constructor throws error if claimsToCheck is not an array', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: 'claim1' as any,
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "claimsToCheck" must be an array');
  });

  it('Constructor throws error if claimsToCheck is an empty array', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: [],
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "claimsToCheck" must contain at least 1 items');
  });

  it('Constructor throws error if claimsToCheck contains non-string values', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1', 123 as any],
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "claimsToCheck[1]" must be a string');
  });

  it('Constructor throws error if claimsToCheck is provided and payloadKey is not provided', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        } as any)
    ).toThrow('Invalid input: "payloadKey" is required');
  });

  it('Constructor throws error if claimsToCheck is provided and payloadKey is not a string', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 123 as any,
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "payloadKey" must be a string');
  });

  it('Constructor throws error if opaqueHeader is not a string', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          opaqueHeader: 123 as any,
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        })
    ).toThrow('Invalid input: "opaqueHeader" must be a string');
  });

  it('Constructor throws error if filter is not provided', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
        } as any)
    ).toThrow('Invalid input: "filter" is required');
  });

  it('Constructor throws error if filter is not an object', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: 'filter' as any,
        })
    ).toThrow('Invalid input: "filter" must be of type object');
  });

  it('Constructor throws error if grpcEnabled is true and grpcPort is not provided', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: true,
        } as any)
    ).toThrow('Invalid input: "grpcPort" is required');
  });

  it('Constructor throws error if grpcEnabled is not a boolean', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: 'true' as any,
          grpcPort: '50051' as any,
        })
    ).toThrow('Invalid input: "grpcEnabled" must be a boolean');
  });

  it('Constructor throws error if grpcPort is provide and GrpcEnabled is not provided', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcPort: '50051' as any,
        })
    ).toThrow('Invalid input: "grpcPort" is not allowed');
  });

  it('Constructor throws error if grpcPort is not a number', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: true,
          grpcPort: '50051' as any,
        })
    ).toThrow('Invalid input: "grpcPort" must be a number');
  });

  it('Constructor throws error if BloomFilterManager initialization fails', async () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { fpRate: 0.01, rotateTime: 2000 } as any,
        })
    ).toThrow('Failed to initialize BloomFilterManager: Invalid input: "numItems" is required');
  });

  it('Constructor not throws error if grpcEnabled is false and grpcPort is not provided', async () => {
    let revoker: Revoker;
    expect(
      () =>
        (revoker = new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: false,
        }))
    ).not.toThrow();
    await revoker!.destroy();
  });

  it('Constructor not throws error if all required parameters are provided for JWT', async () => {
    let revoker: Revoker;
    expect(
      () =>
        (revoker = new Revoker({
          id: 'test',
          claimsToCheck: ['claim1'],
          payloadKey: 'token',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: true,
          grpcPort: 50051,
        }))
    ).not.toThrow();
    await revoker!.destroy();
  });

  it('Constructor not throws error if all required parameters are provided for Opaque', () => {
    expect(
      () =>
        new Revoker({
          id: 'test',
          opaqueHeader: 'Authorization',
          logger,
          filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
          grpcEnabled: true,
          grpcPort: '50051' as any,
        })
    ).not.toThrow();
  });

  it('Constructor initializes BloomFilterManager with correct parameters', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: {
        numItems: 1000,
        fpRate: 0.01,
        rotateTime: 2000,
        backup: true,
        backupRatioTime: 2,
      },
    });

    expect(revoker.bloomFilterManager!.id).toBe('test');
    expect(revoker.bloomFilterManager!.numItems).toBe(1000);
    expect(revoker.bloomFilterManager!.fpRate).toBe(0.01);
    expect(revoker.bloomFilterManager!.rotateTime).toBe(2000);
    expect((revoker.bloomFilterManager as any).backupEnabled).toBe(true);
    expect((revoker.bloomFilterManager as any).backupRatioTime).toBe(2);
    await revoker.destroy();
  });
});

describe('Revoker Class Tests', () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('grpcInit method do nothing if grpcEnabled is false', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: false,
    });

    await revoker._grpcInit();
    expect(Revoker.grpcServerStarted).toBe(false);
    await revoker.destroy();
  });

  it('grpcInit method do nothing if grpcEnabled is omitted', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    await revoker._grpcInit();
    expect(Revoker.grpcServerStarted).toBe(false);
    await revoker.destroy();
  });

  it('grpcInit method starts gRPC server if grpcEnabled is true', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: true,
        grpcPort: 50051,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await revoker._grpcInit();
    expect(revokerStore.init).toHaveBeenCalledOnce();
    expect(startServerSpy).toHaveBeenCalledOnce();
    expect(startServerSpy).toHaveBeenCalledWith(50051, RevokerStore, logger);
    expect(revokerStore.registerInstance).toHaveBeenCalledOnce();
    expect(revokerStore.registerInstance).toHaveBeenCalledWith(revoker);
    expect(Revoker.grpcServerStarted).toBe(true);
    await revoker.destroy();
  });

  it('grpcInit method only register instance ig grpcServerStarted is true', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: true,
        grpcPort: 50051,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    Revoker.grpcServerStarted = true;
    await revoker._grpcInit();
    expect(revokerStore.init).not.toHaveBeenCalled();
    expect(startServerSpy).not.toHaveBeenCalled();
    expect(revokerStore.registerInstance).toHaveBeenCalledOnce();
    expect(revokerStore.registerInstance).toHaveBeenCalledWith(revoker);
    expect(Revoker.grpcServerStarted).toBe(true);
    await revoker.destroy();
  });

  it('grpcInit method logs error if startServer fails', async () => {
    const startServerSpy = vi.fn().mockImplementation(() => {
      throw new Error('Start server failed');
    });
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: true,
        grpcPort: 50051,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await expect(revoker._grpcInit()).rejects.toThrow('Failed to start gRPC server: Start server failed');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Failed to start gRPC server: Start server failed');
    await revoker.destroy();
  });

  it('grpcInit method logs error if registerInstance fails', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn().mockImplementation(() => {
        throw new Error('Register instance failed');
      }),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: true,
        grpcPort: 50051,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await expect(revoker._grpcInit()).rejects.toThrow(
      'Failed to start gRPC server: Register instance failed'
    );
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Failed to start gRPC server: Register instance failed');
    await revoker.destroy();
  });

  it('add method handles empty or invalid input', async () => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    expect(() => revoker.add('')).toThrow('Value must be a non-empty string');
    expect(() => revoker.add(null as any)).toThrow('Value must be a non-empty string');
    expect(() => revoker.add(undefined as any)).toThrow('Value must be a non-empty string');

    await revoker.destroy();
  });

  it('add method handles null bloomFilterManager', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    expect(() => revoker.add('test')).toThrow('Bloom filter manager not initialized');
    await revoker.destroy();
  });

  it('add throws error when gRPC is enabled', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: true,
      grpcPort: 50051,
    });
    console.log(revoker.constructor);
    await revoker._grpcInit();
    console.log('toto');

    expect(() => revoker.add('test')).toThrow('gRPC is enabled, use the gRPC method instead');
    await revoker.destroy();
  });

  it('add calls bloomFilterManager.add and throws error if add fails', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const addStub = vi.spyOn(revoker.bloomFilterManager!, 'add').mockImplementation(() => {
      throw new Error('Add failed');
    });
    expect(() => revoker.add('test')).toThrow('Add failed');
    expect(addStub).toHaveBeenCalledOnce();
    expect(addStub).toHaveBeenCalledWith('test');
    await revoker.destroy();
  });

  it('has calls bloomFilterManager.has and throws error if has fails', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const hasStub = vi.spyOn(revoker.bloomFilterManager!, 'has').mockImplementation(() => {
      throw new Error('Has failed');
    });
    expect(() => revoker.has('test')).toThrow('Has failed');
    expect(hasStub).toHaveBeenCalledOnce();
    expect(hasStub).toHaveBeenCalledWith('test');
    await revoker.destroy();
  });

  it('has throws error when bloomFilterManager is null', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    expect(() => revoker.has('test')).toThrow('Bloom filter manager not initialized');
    await revoker.destroy();
  });

  it('has method throws error when gRPC is enabled', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: true,
      grpcPort: 50051,
    });
    await revoker._grpcInit();
    expect(() => revoker.has('test')).toThrow('gRPC is enabled, use the gRPC method instead');
    await revoker.destroy();
  });

  it('has method handles empty or invalid input', async () => {
    const revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    expect(() => revoker.has('')).toThrow('Value must be a non-empty string');
    expect(() => revoker.has(null as any)).toThrow('Value must be a non-empty string');
    expect(() => revoker.has(undefined as any)).toThrow('Value must be a non-empty string');

    await revoker.destroy();
  });

  it('getMetrics calls bloomFilterManager.getMetrics', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const getMetricsStub = vi
      .spyOn(revoker.bloomFilterManager!, 'getMetrics')
      .mockReturnValue({ test: 'metrics' } as any);
    const metrics = revoker.getMetrics();
    expect(metrics).toEqual({ test: 'metrics' });
    expect(getMetricsStub).toHaveBeenCalledOnce();
    await revoker.destroy();
  });

  it('getMetrics logs error when bloomFilterManager is null', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    expect(() => revoker.getMetrics()).toThrow('Bloom filter manager not initialized');
    await revoker.destroy();
  });

  it('reset and restore method throw error when bloomFilterManager is null', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    await expect(revoker.resetAndRestore()).rejects.toThrow('Bloom filter manager not initialized');
    await revoker.destroy();
  });

  it('resetAndRestore calls bloomFilterManager.resetAndRestore', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const resetAndRestoreStub = vi
      .spyOn(revoker.bloomFilterManager!, 'resetAndRestore')
      .mockResolvedValue();
    logger.info.mockClear();
    await revoker.resetAndRestore();
    expect(resetAndRestoreStub).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('Bloom filter has been reset and restored successfully.');
    await revoker.destroy();
  });

  it('resetAndRestore calls bloomFilterManager.resetAndRestore and logs error if resetAndRestore fails', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const resetAndRestoreStub = vi
      .spyOn(revoker.bloomFilterManager!, 'resetAndRestore')
      .mockRejectedValue(new Error('Reset failed'));
    await expect(revoker.resetAndRestore()).rejects.toThrow('Reset failed');
    expect(resetAndRestoreStub).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Error in Revoker.resetAndRestore:');
    expect((logger.error.mock.calls[0][1] as Error).message).toBe('Reset failed');
    await revoker.destroy();
  });

  it('resetAndRestore throws error when gRPC is enabled', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: true,
      grpcPort: 50051,
    });
    await revoker._grpcInit();
    await expect(() => revoker.resetAndRestore()).rejects.toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
    await revoker.destroy();
  });

  it('resetAndClearData throws error when gRPC is enabled', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: true,
      grpcPort: 50051,
    });
    await revoker._grpcInit();
    await expect(() => revoker.resetAndClearData()).rejects.toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
    await revoker.destroy();
  });

  it('resetAndClearData calls bloomFilterManager.resetAndClearData and logs error if resetAndClearData fails', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const resetAndClearDataStub = vi
      .spyOn(revoker.bloomFilterManager!, 'resetAndClearData')
      .mockRejectedValue(new Error('Reset failed'));
    await expect(revoker.resetAndClearData()).rejects.toThrow('Reset failed');
    expect(resetAndClearDataStub).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Error in revoker.resetAndClearData:');
    expect((logger.error.mock.calls[0][1] as Error).message).toBe('Reset failed');
    await revoker.destroy();
  });

  it('ResetAndClearData trhow error when bloomFilterManager is null', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.bloomFilterManager!.destroy();
    revoker.bloomFilterManager = null;
    await expect(async () => await revoker.resetAndClearData()).rejects.toThrow(
      'Bloom filter manager not initialized'
    );
    await revoker.destroy();
  });

  it('resetAndClearData calls bloomFilterManager.resetAndClearData', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const resetAndClearDataStub = vi
      .spyOn(revoker.bloomFilterManager!, 'resetAndClearData')
      .mockResolvedValue();
    logger.info.mockClear();
    await revoker.resetAndClearData();
    expect(resetAndClearDataStub).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith('Bloom filter has been reset and data cleared successfully.');
    await revoker.destroy();
  });

  it('destroy logs error if destroy fails', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const destroyStub = vi.spyOn(revoker.bloomFilterManager!, 'destroy').mockImplementation(() => {
      throw new Error('Destroy failed');
    });
    await expect(revoker.destroy()).rejects.toThrow('Failed to destroy Revoker: Destroy failed');
    expect(destroyStub).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toBe('Error during Revoker destruction:');
    expect((logger.error.mock.calls[0][1] as Error).message).toBe('Destroy failed');
    destroyStub.mockRestore();
    await revoker.destroy();
  });

  it('destroy do nothing if grpcEnabled is false', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: false,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await revoker.destroy();
    expect(revokerStore.unregisterInstance).not.toHaveBeenCalled();
    expect(Revoker.grpcServerStarted).toBe(false);
  });

  it('destroy do nothing if grpcEnabled is omitted', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await revoker.destroy();
    expect(revokerStore.unregisterInstance).not.toHaveBeenCalled();
    expect(revokerStore.isEmpty).not.toHaveBeenCalled();
    expect(revokerStore.destroy).not.toHaveBeenCalled();
    expect(stopServerSpy).not.toHaveBeenCalled();
    expect(Revoker.grpcServerStarted).toBe(false);
  });

  it('destroy calls unregisterInstance and stopServer if grpcEnabled is true', async () => {
    const startServerSpy = vi.fn();
    const stopServerSpy = vi.fn();

    const revokerStore = {
      init: vi.fn(),
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
      isEmpty: vi.fn().mockReturnValue(true),
      destroy: vi.fn(),
    };

    const revoker = new Revoker(
      {
        id: 'test',
        claimsToCheck: ['claim1'],
        payloadKey: 'token',
        logger,
        filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
        grpcEnabled: true,
        grpcPort: 50051,
      },
      { startServerFn: startServerSpy as any, stopServerFn: stopServerSpy as any },
      revokerStore as any
    );

    await revoker._grpcInit();
    expect(Revoker.grpcServerStarted).toBe(true);

    await revoker.destroy();
    expect(revokerStore.unregisterInstance).toHaveBeenCalledOnce();
    expect(revokerStore.unregisterInstance).toHaveBeenCalledWith(revoker.id);
    expect(revoker.grpcEnabled).toBe(false);
    expect(revokerStore.isEmpty).toHaveBeenCalledOnce();
    // Ordering: isEmpty called after unregisterInstance
    expect(revokerStore.isEmpty.mock.invocationCallOrder[0]).toBeGreaterThan(
      revokerStore.unregisterInstance.mock.invocationCallOrder[0]
    );
    expect(revokerStore.destroy).toHaveBeenCalledOnce();
    // Ordering: destroy called after isEmpty
    expect(revokerStore.destroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      revokerStore.isEmpty.mock.invocationCallOrder[0]
    );
    expect(stopServerSpy).toHaveBeenCalledOnce();
    expect(stopServerSpy).toHaveBeenCalledWith(logger);
    // Ordering: stopServer called after destroy
    expect(stopServerSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      revokerStore.destroy.mock.invocationCallOrder[0]
    );
    expect(Revoker.grpcServerStarted).toBe(false);
  });

  it('destroy logs warning if bloomFilterManager is already destroyed', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const manager = revoker.bloomFilterManager;
    revoker.bloomFilterManager = null;
    await revoker.destroy();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('Bloom filter manager already destroyed');
    // Restore the manager for correct cleanup
    revoker.bloomFilterManager = manager;
    await revoker.destroy();
  });

  it('destroy method handles multiple calls safely', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    await revoker.destroy();
    expect(async () => await revoker.destroy()).not.toThrow();
    expect(revoker.bloomFilterManager).toBeNull();
  });

  it('destroy method handles multiple calls safely and sets bloomFilterManager to null', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    await revoker.destroy();
    expect(async () => await revoker.destroy()).not.toThrow();
    expect(revoker.bloomFilterManager).toBeNull();
  });

  it('destroy method calls destroy on bloomFilterManager', async () => {
    const destroySpy = vi.spyOn(BloomFilterManager.prototype, 'destroy');
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    await revoker.destroy();
    expect(destroySpy).toHaveBeenCalledOnce();
    expect(revoker.bloomFilterManager).toBeNull();
    expect(revoker.middleware).toBeNull();
    destroySpy.mockRestore();
  });

  it('getMiddleware throws error if middleware is not present', async () => {
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    revoker.middleware = null;
    expect(() => revoker.getMiddleware()).toThrow('Middleware not configured');
    await revoker.destroy();
  });

  it('bloom filter restet is called if reset revoker is called', async () => {
    const resetSpy = vi.spyOn(BloomFilterManager.prototype, 'resetAndRestore');
    const revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });
    await revoker.resetAndRestore();
    expect(resetSpy).toHaveBeenCalledOnce();
    await revoker.destroy();
  });
});

describe('Extended Middleware Tests', () => {
  let logger: MockLogger;
  let revoker: Revoker;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(async () => {
    if (revoker) {
      await revoker.destroy();
    }
  });

  it('JWT Middleware - handles non-string claim values', async () => {
    revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const middleware = revoker.getMiddleware();
    const next = vi.fn();
    const req = {
      token: {
        claim1: { nested: 'value' },
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    middleware(req as any, res as any, next as any);
    expect(next).toHaveBeenCalled();
    await revoker.destroy();
  });

  it('JWT Middleware - handles array of claim values', async () => {
    revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const middleware = revoker.getMiddleware();
    const next = vi.fn();
    const req = {
      token: {
        claim1: ['value1', 'value2'],
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    middleware(req as any, res as any, next as any);
    expect(next).toHaveBeenCalled();
  });

  it('Opaque Middleware - handles empty string token', async () => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const middleware = revoker.getMiddleware();
    const next = vi.fn();
    const req = {
      headers: {
        authorization: 'Bearer ',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe('Invalid authorization header');
    }
  });

  it('Opaque Middleware - handles malformed Bearer token', async () => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'Authorization',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const middleware = revoker.getMiddleware();
    const next = vi.fn();
    const req = {
      headers: {
        authorization: 'Bearer token extra',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    try {
      middleware(req as any, res as any, next as any);
    } catch (error) {
      expect((error as Error).message).toBe('Invalid authorization header');
    }
  });

  it('Opaque Middleware - handles case-insensitive header names', async () => {
    revoker = new Revoker({
      id: 'test',
      opaqueHeader: 'X-Custom-Token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
    });

    const middleware = revoker.getMiddleware();
    const next = vi.fn();
    const req = {
      headers: {
        'x-custom-token': 'validToken',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    middleware(req as any, res as any, next as any);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('Revoker Class - gRPC Tests', () => {
  const logger = createMockLogger();
  let revoker: Revoker;

  beforeAll(async () => {
    revoker = new Revoker({
      id: 'test',
      claimsToCheck: ['claim1'],
      payloadKey: 'token',
      logger,
      filter: { numItems: 1000, fpRate: 0.01, rotateTime: 2000 },
      grpcEnabled: true,
      grpcPort: 50051,
    });
    await revoker._grpcInit();
  });

  afterAll(async () => {
    if (revoker) {
      await revoker.destroy();
    }
  });

  it('All exposed throws error when gRPC is enabled', async () => {
    expect(() => revoker.has('test')).toThrow('gRPC is enabled, use the gRPC method instead');
    expect(() => revoker.getMetrics()).toThrow('gRPC is enabled, use the gRPC method instead');
    await expect(revoker.resetAndRestore()).rejects.toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
    await expect(revoker.resetAndClearData()).rejects.toThrow(
      'gRPC is enabled, use the gRPC method instead'
    );
  });
});
