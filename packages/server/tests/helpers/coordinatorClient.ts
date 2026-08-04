import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Test-side gRPC client plumbing for the RevokerCoordinator service.
 * Loads the exact same distributed.proto the server loads (through core's
 * subpath export) so the tests exercise the real wire protocol.
 */

function resolveProtoPath(): string {
  const specifier = 'express-token-revoker/grpc/protos/distributed.proto';
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    const require = createRequire(import.meta.url);
    return require.resolve(specifier);
  }
}

const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor: any = grpc.loadPackageDefinition(packageDefinition);

/** Shape of one StreamEvent as received on the wire (oneofs: true). */
export interface WireStreamEvent {
  event?: 'entry' | 'rotate' | 'keepalive' | 'resnapshot';
  entry?: { lsn: string; generation: number; item: string };
  rotate?: { lsn: string; generation: number };
  keepalive?: Record<string, never>;
  resnapshot?: { generation: number };
}

export interface CoordinatorTestClient {
  add(request: { nodeId?: string; item: string }): Promise<{
    success: boolean;
    message: string;
    lsn: string;
  }>;
  has(request: { nodeId?: string; item: string }): Promise<{ exists: boolean }>;
  getSnapshot(request: { nodeId?: string }): Promise<{
    currentBlob: Buffer;
    previousBlob: Buffer;
    generation: number;
    lastBackupLsn: string;
    numItems: number;
    fpRate: number;
    k: number;
    rotateTime: number;
  }>;
  pollDeltas(request: {
    nodeId?: string;
    fromLsn: string | number;
    maxEvents?: number;
  }): Promise<{ events: WireStreamEvent[]; moreAvailable: boolean }>;
  listNodes(): Promise<{
    nodes: Array<{ nodeId: string; lastLsn: string; lastSeenMs: string; connected: boolean }>;
  }>;
  subscribe(request: { nodeId: string; lastLsn: string | number }): grpc.ClientReadableStream<WireStreamEvent>;
  close(): void;
}

/**
 * Creates a raw grpc-js client for the RevokerCoordinator service.
 */
export function createTestCoordinatorClient(address: string): CoordinatorTestClient {
  const raw: any = new protoDescriptor.revoker.distributed.RevokerCoordinator(
    address,
    grpc.credentials.createInsecure()
  );

  const unary = <TReq, TRes>(method: string, request: TReq): Promise<TRes> =>
    new Promise<TRes>((resolve, reject) => {
      raw[method](request, (err: grpc.ServiceError | null, response: TRes) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });

  return {
    add: (request) => unary('Add', request),
    has: (request) => unary('Has', request),
    getSnapshot: (request) => unary('GetSnapshot', request),
    pollDeltas: (request) => unary('PollDeltas', request),
    listNodes: () => unary('ListNodes', {}),
    subscribe: (request) => raw.Subscribe(request),
    close: () => raw.close(),
  };
}

/**
 * Collects exactly `count` events from a Subscribe stream, or rejects on
 * error / timeout. Events are returned in arrival order.
 */
export function collectStreamEvents(
  stream: grpc.ClientReadableStream<WireStreamEvent>,
  count: number,
  timeoutMs = 10000
): Promise<WireStreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: WireStreamEvent[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} stream events (got ${events.length})`));
    }, timeoutMs);

    const onData = (event: WireStreamEvent): void => {
      events.push(event);
      if (events.length >= count) {
        cleanup();
        resolve(events);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('error', onError);
  });
}

/**
 * Waits for the server to end the stream (e.g. after ResnapshotRequired),
 * collecting every event received until then.
 */
export function collectUntilEnd(
  stream: grpc.ClientReadableStream<WireStreamEvent>,
  timeoutMs = 10000
): Promise<WireStreamEvent[]> {
  return new Promise((resolve, reject) => {
    const events: WireStreamEvent[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the stream to end'));
    }, timeoutMs);

    const onData = (event: WireStreamEvent): void => {
      events.push(event);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(events);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * Cancels a Subscribe stream safely: cancel() emits a CANCELLED error on
 * the stream, which must have a listener attached or it becomes uncaught.
 */
export function cancelStream(stream: grpc.ClientReadableStream<unknown>): void {
  stream.removeAllListeners('error');
  stream.on('error', () => {
    // Expected CANCELLED status after cancel() — swallow.
  });
  stream.cancel();
}

/**
 * Waits for a Subscribe stream to fail with a specific gRPC status code.
 */
export function waitForStreamError(
  stream: grpc.ClientReadableStream<WireStreamEvent>,
  expectedCode: number,
  timeoutMs = 10000
): Promise<grpc.ServiceError> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stream error (code ${expectedCode})`));
    }, timeoutMs);

    const onError = (error: grpc.ServiceError): void => {
      cleanup();
      if (error.code === expectedCode) {
        resolve(error);
      } else {
        reject(new Error(`Expected gRPC code ${expectedCode}, got ${error.code}: ${error.message}`));
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`Stream ended cleanly; expected error code ${expectedCode}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
    };

    stream.on('error', onError);
    stream.on('end', onEnd);
  });
}
