import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { InternalError, ValidationError } from 'express-token-revoker';
import type { GenericLogger, SnapshotResponse, WireStreamEvent } from './types.js';
import type { AuthMode, NodeAuthConfig } from './validation.js';

/**
 * Max receive message size: snapshot blobs are 5–10 MB at 1M items /
 * fpRate 1e-9, above gRPC's 4 MB default. Mirrors the coordinator server.
 */
const MAX_MESSAGE_SIZE = 32 * 1024 * 1024; // 32 MB

/** Default deadline for the channel readiness check on first connect. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * gRPC metadata key carrying the shared secret (PD-1 shared-secret mode).
 * Must match the coordinator's interceptor key.
 */
export const SHARED_SECRET_METADATA_KEY = 'x-shared-secret';

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
   * gRPC auth (PD-1). `shared-secret`/`mtls` build TLS channel credentials
   * (mtls adds the client keypair) and inject the secret into every call's
   * metadata; `insecure` uses plaintext credentials and logs a loud
   * warning. Defaults to `insecure` when omitted (low-level client only —
   * createRevokerNode always passes the validated config).
   */
  auth?: NodeAuthConfig;
  /**
   * Extra static metadata attached to every call (escape hatch; the auth
   * block's shared secret wins for the `x-shared-secret` key).
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
    if (this.#authMode() === 'insecure') {
      this.#logger.warn(
        '==============================================================\n' +
          '*** INSECURE MODE: coordinator connection uses NO TLS and NO authentication. ***\n' +
          '*** Development ONLY — never use this configuration in production. ***\n' +
          '=============================================================='
      );
    }
  }

  get nodeId(): string {
    return this.#options.nodeId;
  }

  /** Effective auth mode (PD-1). */
  #authMode(): AuthMode {
    return this.#options.auth?.mode ?? 'insecure';
  }

  /**
   * Builds the channel credentials for the effective auth mode. Unreadable
   * credential files fail the connect cleanly with a ValidationError.
   */
  #channelCredentials(): grpc.ChannelCredentials {
    const mode = this.#authMode();
    if (mode === 'insecure') {
      return grpc.credentials.createInsecure();
    }
    const auth = this.#options.auth as NodeAuthConfig & {
      caCertPath: string;
      secret: string;
    };
    try {
      const ca = readFileSync(auth.caCertPath);
      if (mode === 'mtls') {
        const clientKey = readFileSync(auth.clientKeyPath as string);
        const clientCert = readFileSync(auth.clientCertPath as string);
        return grpc.ChannelCredentials.createSsl(ca, clientKey, clientCert);
      }
      return grpc.ChannelCredentials.createSsl(ca);
    } catch (error) {
      throw new ValidationError(
        `Failed to load coordinator client TLS credentials (${(error as Error).message}). ` +
          `Check auth.caCertPath${mode === 'mtls' ? '/clientCertPath/clientKeyPath' : ''} (mode: ${mode}).`
      );
    }
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

    const client = createRaw(this.#options.address, this.#channelCredentials());

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
    const extra = this.#options.authMetadata;
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        metadata.set(key, value);
      }
    }
    // PD-1: the shared secret rides on every call in TLS modes (the
    // coordinator's interceptor validates it; the TLS layer already
    // authenticates the server — "API key over HTTPS").
    const mode = this.#authMode();
    const secret = this.#options.auth?.secret;
    if ((mode === 'shared-secret' || mode === 'mtls') && secret) {
      metadata.set(SHARED_SECRET_METADATA_KEY, secret);
    }
    return metadata;
  }

  /** Bootstrap snapshot: blobs + consistency point + geometry. */
  async getSnapshot(): Promise<SnapshotResponse> {
    const client = await this.ensureConnected();
    return new Promise<SnapshotResponse>((resolve, reject) => {
      client.GetSnapshot({ nodeId: this.#options.nodeId }, this.#metadata(), (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
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
