import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { InternalError } from 'express-token-revoker';
import type { GenericLogger, SnapshotResponse, WireStreamEvent } from './types.js';

/**
 * Max receive message size: snapshot blobs are 5–10 MB at 1M items /
 * fpRate 1e-9, above gRPC's 4 MB default. Mirrors the coordinator server.
 */
const MAX_MESSAGE_SIZE = 32 * 1024 * 1024; // 32 MB

/** Default deadline for the channel readiness check on first connect. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Resolves the canonical distributed.proto shipped by the core package
 * (same mechanism as packages/server — one wire definition for everyone).
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

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as grpc.GrpcObject;
const distributedProto: any = (protoDescriptor.revoker as grpc.GrpcObject).distributed;

/**
 * Raw grpc-js client surface the CoordinatorClient drives. Extracted so the
 * shared-init-promise discipline is unit-testable with a stub (mirrors
 * core's gRPCFunctions DI convention — tests only).
 */
export interface RawCoordinatorClient {
  waitForReady(deadline: number, callback: (error: Error | null) => void): void;
  GetSnapshot(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: SnapshotResponse) => void
  ): void;
  Subscribe(
    request: Record<string, unknown>,
    metadata: grpc.Metadata
  ): grpc.ClientReadableStream<WireStreamEvent>;
  PollDeltas(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (
      error: grpc.ServiceError | null,
      response: { events: WireStreamEvent[]; moreAvailable: boolean }
    ) => void
  ): void;
  ListNodes(
    request: Record<string, unknown>,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: unknown) => void
  ): void;
  close(): void;
}

/** Options for the coordinator client. */
export interface CoordinatorClientOptions {
  /** Coordinator address (`host:port`). */
  address: string;
  /** This node's id — sent on every request. */
  nodeId: string;
  logger: GenericLogger;
  /**
   * PD-1 placeholder: static metadata attached to every call (e.g. a
   * shared-secret header). This is NOT real transport security — the auth
   * decision (PD-1) is pending; v1 assumes a trusted/loopback network.
   */
  authMetadata?: Record<string, string>;
  /** Deadline for the first channel readiness check. */
  connectTimeoutMs?: number;
  /**
   * Test seam: replaces the grpc-js client constructor (mirrors core's
   * gRPCFunctions DI convention — reserved for tests).
   */
  createRawClient?: (address: string, credentials: grpc.ChannelCredentials) => RawCoordinatorClient;
}

/**
 * gRPC client for the RevokerCoordinator service, from the node's side.
 *
 * Bootstrap uses the same shared-init-promise discipline as core's
 * `grpcServerInitPromise`: the first caller establishes the channel,
 * concurrent callers await the SAME promise, and a failure resets the
 * promise and cleans the partial channel so the next caller can retry.
 */
export class CoordinatorClient {
  readonly #options: CoordinatorClientOptions;
  readonly #logger: GenericLogger;
  #clientPromise: Promise<RawCoordinatorClient> | null = null;
  #closed = false;

  constructor(options: CoordinatorClientOptions) {
    this.#options = options;
    this.#logger = options.logger;
  }

  get nodeId(): string {
    return this.#options.nodeId;
  }

  /**
   * Returns a ready channel/client. First call performs the connect;
   * concurrent calls share the same promise; a failed connect resets the
   * promise (and closes the partial channel) so a later call retries.
   */
  ensureConnected(): Promise<RawCoordinatorClient> {
    if (this.#closed) {
      return Promise.reject(new InternalError('Coordinator client is closed'));
    }
    if (this.#clientPromise) {
      return this.#clientPromise;
    }

    this.#clientPromise = this.#connect().catch((error) => {
      // Reset + clean so the next caller retries from scratch (core's
      // grpcServerInitPromise pattern).
      this.#clientPromise = null;
      throw error;
    });
    return this.#clientPromise;
  }

  async #connect(): Promise<RawCoordinatorClient> {
    const createRaw =
      this.#options.createRawClient ??
      ((address: string, credentials: grpc.ChannelCredentials) =>
        new distributedProto.RevokerCoordinator(address, credentials, {
          'grpc.max_receive_message_size': MAX_MESSAGE_SIZE,
          'grpc.max_send_message_size': MAX_MESSAGE_SIZE,
        }) as RawCoordinatorClient);

    const client = createRaw(this.#options.address, grpc.credentials.createInsecure());

    const timeoutMs = this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    try {
      await new Promise<void>((resolve, reject) => {
        client.waitForReady(Date.now() + timeoutMs, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      try {
        client.close();
      } catch {
        // Best effort — the connect failure is reported below.
      }
      throw new InternalError(
        `Failed to connect to the coordinator at ${this.#options.address}: ${
          (error as Error).message
        }`
      );
    }

    this.#logger.info(`Connected to coordinator at ${this.#options.address}`);
    return client;
  }

  #metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    const auth = this.#options.authMetadata;
    if (auth) {
      for (const [key, value] of Object.entries(auth)) {
        metadata.set(key, value);
      }
    }
    return metadata;
  }

  /** Bootstrap snapshot: blobs + consistency point + geometry. */
  async getSnapshot(): Promise<SnapshotResponse> {
    const client = await this.ensureConnected();
    return new Promise<SnapshotResponse>((resolve, reject) => {
      client.GetSnapshot(
        { nodeId: this.#options.nodeId },
        this.#metadata(),
        (error, response) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Opens the replication stream, resuming AFTER `lastLsn`.
   * The caller owns the stream lifecycle (data/error/end listeners).
   */
  async subscribe(lastLsn: number): Promise<grpc.ClientReadableStream<WireStreamEvent>> {
    const client = await this.ensureConnected();
    return client.Subscribe(
      { nodeId: this.#options.nodeId, lastLsn: String(lastLsn) },
      this.#metadata()
    );
  }

  /** Degraded-mode unary catch-up (same events as Subscribe, paged). */
  async pollDeltas(
    fromLsn: number,
    maxEvents: number
  ): Promise<{ events: WireStreamEvent[]; moreAvailable: boolean }> {
    const client = await this.ensureConnected();
    return new Promise<{ events: WireStreamEvent[]; moreAvailable: boolean }>((resolve, reject) => {
      client.PollDeltas(
        { nodeId: this.#options.nodeId, fromLsn: String(fromLsn), maxEvents },
        this.#metadata(),
        (error, response) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /** Cluster observability (diagnostics). */
  async listNodes(): Promise<unknown> {
    const client = await this.ensureConnected();
    return new Promise<unknown>((resolve, reject) => {
      client.ListNodes({}, this.#metadata(), (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  /** Closes the channel and resets the shared init promise. Idempotent. */
  close(): void {
    this.#closed = true;
    const pending = this.#clientPromise;
    this.#clientPromise = null;
    if (pending) {
      pending
        .then((client) => client.close())
        .catch(() => {
          // Connect failed — nothing to close.
        });
    }
  }
}
