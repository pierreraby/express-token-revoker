import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

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
  /** Populated lag hints: coordinator lastLsn (int64 string) + generation. */
  keepalive?: { coordinatorLastLsn?: string; generation?: number };
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
  subscribe(request: {
    nodeId: string;
    lastLsn: string | number;
  }): grpc.ClientReadableStream<WireStreamEvent>;
  close(): void;
}

/**
 * Per-stream buffered state, fed by ONE persistent 'data' listener attached
 * the moment the Subscribe stream is created. Every event that arrives —
 * including while the test is busy with unary RPCs between two collects —
 * is appended here, so nothing is ever dropped in the gap.
 */
interface StreamBuffer {
  /** Every event received on the stream, in arrival order. */
  events: WireStreamEvent[];
  /** Set if the stream failed; pending and future collects reject with it. */
  error?: Error;
  /** Set once the stream ends cleanly. */
  ended: boolean;
  /** Collects currently waiting for more events. */
  waiters: Array<{
    collected: WireStreamEvent[];
    count: number;
    filter?: (event: WireStreamEvent) => boolean;
    resolve: (events: WireStreamEvent[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

const streamBuffers = new WeakMap<grpc.ClientReadableStream<WireStreamEvent>, StreamBuffer>();

/** Attaches the persistent listeners that feed `buffer` (idempotent per stream). */
function trackStream(stream: grpc.ClientReadableStream<WireStreamEvent>): StreamBuffer {
  const buffer: StreamBuffer = { events: [], ended: false, waiters: [] };
  streamBuffers.set(stream, buffer);

  stream.on('data', (event: WireStreamEvent) => {
    buffer.events.push(event);
    pumpWaiters(buffer);
  });
  stream.on('error', (error: Error) => {
    buffer.error = error;
    failWaiters(buffer, error);
  });
  stream.on('end', () => {
    buffer.ended = true;
    if (buffer.waiters.length > 0) {
      failWaiters(buffer, new Error('Stream ended before the requested events arrived'));
    }
  });

  return buffer;
}

function getStreamBuffer(stream: grpc.ClientReadableStream<WireStreamEvent>): StreamBuffer {
  return streamBuffers.get(stream) ?? trackStream(stream);
}

/**
 * Removes up to `needed` events matching `filter` from the front of
 * `events`, preserving arrival order. Non-matching events stay buffered
 * for later collects (they are never lost).
 */
function takeMatching(
  events: WireStreamEvent[],
  needed: number,
  filter?: (event: WireStreamEvent) => boolean
): WireStreamEvent[] {
  const taken: WireStreamEvent[] = [];
  for (let i = 0; i < events.length && taken.length < needed; i++) {
    const event = events[i];
    if (!filter || filter(event)) {
      taken.push(event);
      events.splice(i, 1);
      i--;
    }
  }
  return taken;
}

/** Feeds every pending waiter from the buffer; resolves the satisfied ones. */
function pumpWaiters(buffer: StreamBuffer): void {
  let index = 0;
  while (index < buffer.waiters.length) {
    const waiter = buffer.waiters[index];
    const taken = takeMatching(
      buffer.events,
      waiter.count - waiter.collected.length,
      waiter.filter
    );
    waiter.collected.push(...taken);
    if (waiter.collected.length >= waiter.count) {
      buffer.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(waiter.collected);
    } else {
      index++;
    }
  }
}

function failWaiters(buffer: StreamBuffer, error: Error): void {
  for (const waiter of buffer.waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

/**
 * Creates a raw grpc-js client for the RevokerCoordinator service.
 *
 * Auth (PD-1): pass TLS `credentials` and/or shared-secret `secret` to hit
 * a TLS-mode coordinator; defaults stay plaintext for the insecure-mode
 * test flows.
 */
export function createTestCoordinatorClient(
  address: string,
  options: { credentials?: grpc.ChannelCredentials; secret?: string } = {}
): CoordinatorTestClient {
  const raw: any = new protoDescriptor.revoker.distributed.RevokerCoordinator(
    address,
    options.credentials ?? grpc.credentials.createInsecure()
  );

  const metadata = (): grpc.Metadata => {
    const md = new grpc.Metadata();
    if (options.secret !== undefined) {
      md.set('x-shared-secret', options.secret);
    }
    return md;
  };

  const unary = <TReq, TRes>(method: string, request: TReq): Promise<TRes> =>
    new Promise<TRes>((resolve, reject) => {
      raw[method](request, metadata(), (err: grpc.ServiceError | null, response: TRes) => {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });

  return {
    // nodeId identifies the admin caller (validated server-side, used for
    // the audit log); tests that don't care about it get a valid default.
    add: (request) => unary('Add', { nodeId: request.nodeId ?? 'test-admin', item: request.item }),
    has: (request) => unary('Has', request),
    getSnapshot: (request) => unary('GetSnapshot', request),
    pollDeltas: (request) => unary('PollDeltas', request),
    listNodes: () => unary('ListNodes', {}),
    subscribe: (request) => {
      const stream = raw.Subscribe(
        request,
        metadata()
      ) as grpc.ClientReadableStream<WireStreamEvent>;
      // Buffer every event from the moment the stream exists, so no event
      // can be dropped between two collects.
      trackStream(stream);
      return stream;
    },
    close: () => raw.close(),
  };
}

/**
 * Collects exactly `count` events from a Subscribe stream, or rejects on
 * error / timeout. Events are returned in arrival order. An optional
 * filter skips non-matching events (e.g. interleaved keepalives) without
 * counting them.
 *
 * Events are consumed from the stream's persistent buffer: anything that
 * arrived before this call (or while a previous collect was not attached)
 * is still available, and nothing is lost between two collects.
 */
export function collectStreamEvents(
  stream: grpc.ClientReadableStream<WireStreamEvent>,
  count: number,
  timeoutMs = 10000,
  filter?: (event: WireStreamEvent) => boolean
): Promise<WireStreamEvent[]> {
  const buffer = getStreamBuffer(stream);
  return new Promise((resolve, reject) => {
    if (buffer.error) {
      reject(buffer.error);
      return;
    }
    const waiter: StreamBuffer['waiters'][number] = {
      collected: [],
      count,
      filter,
      resolve,
      reject,
      timer: setTimeout(() => {
        const pendingIndex = buffer.waiters.indexOf(waiter);
        if (pendingIndex >= 0) {
          buffer.waiters.splice(pendingIndex, 1);
        }
        reject(
          new Error(`Timed out waiting for ${count} stream events (got ${waiter.collected.length})`)
        );
      }, timeoutMs),
    };
    buffer.waiters.push(waiter);
    // Consume whatever is already buffered (synchronous path resolves here).
    pumpWaiters(buffer);
    if (buffer.ended && waiter.collected.length < count) {
      const pendingIndex = buffer.waiters.indexOf(waiter);
      if (pendingIndex >= 0) {
        buffer.waiters.splice(pendingIndex, 1);
      }
      clearTimeout(waiter.timer);
      reject(new Error('Stream ended before the requested events arrived'));
    }
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
        reject(
          new Error(`Expected gRPC code ${expectedCode}, got ${error.code}: ${error.message}`)
        );
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
