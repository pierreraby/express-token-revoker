import { describe, it, expect, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import {
  CoordinatorClient,
  type RawCoordinatorClient,
} from '../../src/coordinatorClient.js';
import { createMockLogger } from '../helpers/mock-logger.js';

/**
 * Unit tests for the coordinator client, focused on the shared-init-promise
 * discipline (core's grpcServerInitPromise pattern): first caller connects,
 * concurrent callers await the same promise, failure resets + cleans so the
 * next caller can retry.
 */

interface FakeRawOptions {
  /** waitForReady outcome. */
  readyError?: Error;
}

function makeFakeRaw(options: FakeRawOptions = {}) {
  const fake = {
    waitForReady: vi.fn((_deadline: number, callback: (error: Error | null) => void) => {
      setTimeout(() => callback(options.readyError ?? null), 0);
    }),
    GetSnapshot: vi.fn(),
    Subscribe: vi.fn(),
    PollDeltas: vi.fn(),
    ListNodes: vi.fn(),
    close: vi.fn(),
  };
  return fake as unknown as RawCoordinatorClient & {
    waitForReady: ReturnType<typeof vi.fn>;
    GetSnapshot: ReturnType<typeof vi.fn>;
    Subscribe: ReturnType<typeof vi.fn>;
    PollDeltas: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function makeClient(
  constructions: Array<ReturnType<typeof makeFakeRaw>>,
  options: { authMetadata?: Record<string, string> } = {}
): CoordinatorClient {
  return new CoordinatorClient({
    address: '127.0.0.1:59999',
    nodeId: 'node-a',
    logger: createMockLogger(),
    connectTimeoutMs: 1000,
    authMetadata: options.authMetadata,
    createRawClient: () => {
      const fake = makeFakeRaw();
      constructions.push(fake);
      return fake;
    },
  });
}

describe('CoordinatorClient shared-init-promise discipline', () => {
  it('concurrent ensureConnected calls share ONE construction', async () => {
    const constructions: Array<ReturnType<typeof makeFakeRaw>> = [];
    const client = makeClient(constructions);

    const [a, b, c] = await Promise.all([
      client.ensureConnected(),
      client.ensureConnected(),
      client.ensureConnected(),
    ]);

    expect(constructions).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    client.close();
  });

  it('reuses the established client on later calls', async () => {
    const constructions: Array<ReturnType<typeof makeFakeRaw>> = [];
    const client = makeClient(constructions);

    await client.ensureConnected();
    await client.ensureConnected();

    expect(constructions).toHaveLength(1);
    client.close();
  });

  it('a failed connect closes the partial client and rejects', async () => {
    const failing = makeFakeRaw({ readyError: new Error('connection refused') });
    const client = new CoordinatorClient({
      address: '127.0.0.1:59999',
      nodeId: 'node-a',
      logger: createMockLogger(),
      connectTimeoutMs: 1000,
      createRawClient: () => failing,
    });

    await expect(client.ensureConnected()).rejects.toThrow(/Failed to connect/);
    expect(failing.close).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('after a failure the promise is reset — the next call retries fresh', async () => {
    const failing = makeFakeRaw({ readyError: new Error('connection refused') });
    const healthy = makeFakeRaw();
    const sequence = [failing, healthy];
    const client = new CoordinatorClient({
      address: '127.0.0.1:59999',
      nodeId: 'node-a',
      logger: createMockLogger(),
      connectTimeoutMs: 1000,
      createRawClient: () => sequence.shift() as RawCoordinatorClient,
    });

    await expect(client.ensureConnected()).rejects.toThrow(/Failed to connect/);
    const raw = await client.ensureConnected();
    expect(raw).toBe(healthy);
    expect(healthy.waitForReady).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('close() rejects further calls', async () => {
    const constructions: Array<ReturnType<typeof makeFakeRaw>> = [];
    const client = makeClient(constructions);

    client.close();
    await expect(client.ensureConnected()).rejects.toThrow(/closed/);
  });
});

describe('CoordinatorClient call surface', () => {
  it('getSnapshot promisifies the unary call with nodeId + auth metadata', async () => {
    const constructions: Array<ReturnType<typeof makeFakeRaw>> = [];
    const client = makeClient(constructions, { authMetadata: { 'x-shared-secret': 's3cret' } });

    const response = {
      currentBlob: Buffer.alloc(0),
      previousBlob: Buffer.alloc(0),
      generation: 0,
      lastBackupLsn: '0',
      numItems: 1000,
      fpRate: 0.0001,
      k: 14,
      rotateTime: 60000,
    };

    // The fake resolves like a grpc-js unary handler: (request, metadata, cb).
    const pending = client.getSnapshot();
    await vi.waitFor(() => expect(constructions).toHaveLength(1));
    const raw = constructions[0];
    // The unary call lands after the async channel readiness check.
    await vi.waitFor(() => expect(raw.GetSnapshot).toHaveBeenCalledTimes(1));
    const [request, metadata, callback] = raw.GetSnapshot.mock.calls[0];
    expect(request).toEqual({ nodeId: 'node-a' });
    expect(metadata.get('x-shared-secret')).toEqual(['s3cret']);
    callback(null, response);

    await expect(pending).resolves.toEqual(response);
    client.close();
  });

  it('subscribe passes lastLsn as a string and returns the raw stream', async () => {
    const fakeStream = { on: vi.fn(), cancel: vi.fn() };
    const raw = makeFakeRaw();
    raw.Subscribe.mockReturnValue(fakeStream);
    const client = new CoordinatorClient({
      address: '127.0.0.1:59999',
      nodeId: 'node-a',
      logger: createMockLogger(),
      connectTimeoutMs: 1000,
      createRawClient: () => raw,
    });

    const stream = await client.subscribe(42);

    expect(stream).toBe(fakeStream);
    const [request, metadata] = raw.Subscribe.mock.calls[0];
    expect(request).toEqual({ nodeId: 'node-a', lastLsn: '42' });
    expect(metadata).toBeInstanceOf(grpc.Metadata);
    client.close();
  });

  it('pollDeltas sends fromLsn/maxEvents and resolves the page', async () => {
    const constructions: Array<ReturnType<typeof makeFakeRaw>> = [];
    const client = makeClient(constructions);

    const page = { events: [], moreAvailable: false };
    const pending = client.pollDeltas(7, 500);
    await vi.waitFor(() => expect(constructions).toHaveLength(1));
    const raw = constructions[0];
    // The unary call lands after the async channel readiness check.
    await vi.waitFor(() => expect(raw.PollDeltas).toHaveBeenCalledTimes(1));
    const [request, , callback] = raw.PollDeltas.mock.calls[0];
    expect(request).toEqual({ nodeId: 'node-a', fromLsn: '7', maxEvents: 500 });
    callback(null, page);

    await expect(pending).resolves.toEqual(page);
    client.close();
  });
});
