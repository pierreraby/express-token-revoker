import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ValidationError } from 'express-token-revoker';
import type { Coordinator } from './coordinator.js';
import { itemValidationError } from './coordinator.js';
import type { NodeConnection, NodeRegistry } from './nodeRegistry.js';
import { idPattern } from './validation.js';
import type { CanonicalEvent, GenericLogger, OutboundEvent } from './types.js';

/**
 * Max send/receive message size for the distributed service.
 * Snapshot blobs are 5–10 MB at 1M items / fpRate 1e-9 — the default 4 MB
 * gRPC cap is too small. Chunking is v2.
 */
const MAX_MESSAGE_SIZE = 32 * 1024 * 1024; // 32 MB

/** Backlog drain batch size (events per read while catching a node up). */
const DRAIN_BATCH_SIZE = 1000;

/** Hard cap on events returned by a single PollDeltas call. */
const MAX_POLL_EVENTS = 10_000;

/**
 * Resolves the canonical distributed.proto shipped by the core package.
 * Core exports it through the `./grpc/protos/*` subpath so every package
 * loads the exact same definition.
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
// protoLoader does not generate types for services.
const distributedProto: any = (protoDescriptor.revoker as grpc.GrpcObject).distributed;

/**
 * Whether the host is a loopback address (safe for an unauthenticated
 * service, since only local processes can reach it). Mirrors core's
 * std-server.ts posture.
 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Coerces a proto int64 (delivered as a string with `longs: String`) to a
 * non-negative integer LSN, or null when invalid.
 */
function toLsn(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 0 || !Number.isSafeInteger(num)) {
    return null;
  }
  return num;
}

/**
 * Maps a canonical event to its StreamEvent wire shape. Tombstoned entries
 * are delivered as plain entries: the coordinator's local apply failed, but
 * the entry is still replicated — over-revocation is the safe direction and
 * LSN continuity must never break (see CanonicalWal.appendTombstone).
 */
function toStreamEvent(event: CanonicalEvent): Record<string, unknown> {
  if (event.type === 'rotate') {
    return { rotate: { lsn: String(event.lsn), generation: event.generation } };
  }
  return { entry: { lsn: String(event.lsn), generation: event.generation, item: event.item } };
}

function outboundToStreamEvent(event: OutboundEvent): Record<string, unknown> | null {
  switch (event.kind) {
    case 'entry':
      return { entry: { lsn: String(event.lsn), generation: event.generation, item: event.item } };
    case 'rotate':
      return { rotate: { lsn: String(event.lsn), generation: event.generation } };
    case 'keepalive':
      return { keepalive: {} };
    case 'resnapshot':
      return { resnapshot: { generation: event.generation } };
    default:
      return null;
  }
}

/**
 * Per-node delivery connection: a single-writer promise chain feeding the
 * gRPC server-streaming call. Everything (backlog drain, live events,
 * keepalives) goes through the same chain, so delivery order is always the
 * canonical LSN order — a live event can never overtake the backlog.
 *
 * Dedup happens at write time (not enqueue time): at-least-once delivery
 * plus bloom idempotence makes re-delivery safe, and write-time checks are
 * race-free because writes are serialized on the chain.
 */
class NodeConnectionImpl implements NodeConnection {
  readonly nodeId: string;
  #call: grpc.ServerWritableStream<any, any>;
  #registry: NodeRegistry;
  #logger: GenericLogger;
  #chain: Promise<void> = Promise.resolve();
  #lastWrittenLsn: number;
  #keepaliveTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #onCleanup: () => void;

  constructor(
    call: grpc.ServerWritableStream<any, any>,
    nodeId: string,
    resumeFromLsn: number,
    registry: NodeRegistry,
    logger: GenericLogger,
    onCleanup: () => void
  ) {
    this.#call = call;
    this.nodeId = nodeId;
    this.#registry = registry;
    this.#logger = logger;
    this.#lastWrittenLsn = resumeFromLsn;
    this.#onCleanup = onCleanup;
  }

  /**
   * Starts the periodic keepalive on this stream.
   */
  startKeepalive(intervalMs: number): void {
    this.#keepaliveTimer = setInterval(() => {
      this.enqueue({ kind: 'keepalive' });
      try {
        this.#registry.touch(this.nodeId);
      } catch {
        // Registry destroyed during shutdown — keepalives stop anyway.
      }
    }, intervalMs);
  }

  /**
   * Runs an async task on the node's write chain (used for the backlog
   * drain). The task is serialized with live-event writes.
   */
  enqueueTask(task: () => Promise<void>): void {
    if (this.#closed) {
      return;
    }
    this.#chain = this.#chain.then(task).catch((error: unknown) => {
      this.#logger.error(
        `Node ${this.nodeId}: delivery task failed: ${(error as Error).message}`
      );
      this.close();
    });
  }

  enqueue(event: OutboundEvent): void {
    if (this.#closed) {
      return;
    }
    this.#chain = this.#chain
      .then(() => this.#write(event))
      .catch((error: unknown) => {
        this.#logger.error(`Node ${this.nodeId}: write failed: ${(error as Error).message}`);
        this.close();
      });
  }

  async #write(event: OutboundEvent): Promise<void> {
    if (this.#closed) {
      return;
    }
    const message = outboundToStreamEvent(event);
    if (!message) {
      return;
    }
    if ((event.kind === 'entry' || event.kind === 'rotate') && event.lsn <= this.#lastWrittenLsn) {
      // Already delivered (e.g. the backlog drain covered a live event that
      // was appended mid-drain). At-least-once allows duplicates; we drop
      // the trivial ones here.
      return;
    }

    await this.#writeMessage(message);

    if (event.kind === 'entry' || event.kind === 'rotate') {
      this.#lastWrittenLsn = event.lsn;
      this.#registry.recordSent(this.nodeId, event.lsn);
    }
  }

  /**
   * Writes one message, honoring backpressure (await drain when the kernel
   * buffer is full).
   */
  async #writeMessage(message: Record<string, unknown>): Promise<void> {
    if (this.#closed) {
      return;
    }
    const ok = this.#call.write(message);
    if (!ok) {
      await new Promise<void>((resolve) => {
        if (this.#closed) {
          resolve();
          return;
        }
        this.#call.once('drain', resolve);
      });
    }
  }

  /**
   * Writes an event bypassing the dedup cursor (backlog drain knows its own
   * positions; it updates the cursor explicitly).
   */
  async writeDirect(event: CanonicalEvent): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.#writeMessage(toStreamEvent(event));
    this.#lastWrittenLsn = event.lsn;
    this.#registry.recordSent(this.nodeId, event.lsn);
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#keepaliveTimer) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
    try {
      this.#call.end();
    } catch {
      // The call may already be dead — closing must never throw.
    }
    this.#onCleanup();
  }
}

/**
 * Options for the distributed gRPC server.
 */
export interface DistributedServerOptions {
  coordinator: Coordinator;
  registry: NodeRegistry;
  logger: GenericLogger;
  /** Bind host. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Port (0 = ephemeral; the bound port is returned by start()). */
  port: number;
  /**
   * Allow binding without TLS on a non-loopback host (PD-1 pending — v1
   * default posture mirrors core: loopback only unless explicitly opted in).
   */
  allowInsecure?: boolean;
  /** Interval between stream keepalives in ms. Defaults to 5000. */
  keepaliveIntervalMs?: number;
}

/**
 * The coordinator's gRPC service (RevokerCoordinator from distributed.proto).
 *
 * One server instance per coordinator process. Not a process-wide singleton
 * like core's admin server: the coordinator owns its instance end to end,
 * which keeps multi-coordinator testing possible and lifecycle obvious.
 */
export class DistributedServer {
  readonly #options: DistributedServerOptions;
  readonly #logger: GenericLogger;
  #server: grpc.Server | null = null;
  #boundPort = 0;
  #connections = new Set<NodeConnectionImpl>();

  constructor(options: DistributedServerOptions) {
    this.#options = options;
    this.#logger = options.logger;
  }

  /** The port actually bound (useful with port 0). */
  get boundPort(): number {
    return this.#boundPort;
  }

  /**
   * Starts the server and wires the coordinator's live-event listener to
   * this server's broadcast.
   *
   * The service is unauthenticated: binding a non-loopback host without the
   * explicit allowInsecure opt-in is refused, mirroring core's posture.
   *
   * @returns The bound port.
   * @throws {ValidationError} On a refused non-loopback bind.
   */
  async start(): Promise<number> {
    const host = this.#options.host ?? '127.0.0.1';
    if (!isLoopbackHost(host) && !this.#options.allowInsecure) {
      throw new ValidationError(
        `Refusing to bind the unauthenticated coordinator service to non-loopback host "${host}". ` +
          'The auth/TLS decision (PD-1) is pending: keep the bind loopback-only, or set ' +
          'allowInsecure: true to accept the risk on an isolated/trusted network.'
      );
    }

    this.#options.registry.init();
    this.#options.coordinator.setListener((event) => this.#broadcast(event));

    this.#server = new grpc.Server({
      'grpc.max_receive_message_size': MAX_MESSAGE_SIZE,
      'grpc.max_send_message_size': MAX_MESSAGE_SIZE,
    });
    this.#server.addService(distributedProto.RevokerCoordinator.service, this.#handlers());

    return new Promise<number>((resolve, reject) => {
      const server = this.#server;
      if (!server) {
        return reject(new Error('Server is not initialized'));
      }
      server.bindAsync(
        `${host}:${this.#options.port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, bindPort) => {
          if (err) {
            this.#logger.error(`Failed to bind coordinator on ${host}:${this.#options.port}: ${err.message}`);
            return reject(err);
          }
          this.#boundPort = bindPort;
          this.#logger.info(`Coordinator gRPC service listening on ${host}:${bindPort}`);
          resolve(bindPort);
        }
      );
    });
  }

  /**
   * Fans a live event out to every connected node through its own ordered
   * queue. Never throws — a failing node connection must not break the
   * write path.
   */
  #broadcast(event: OutboundEvent): void {
    for (const connection of this.#connections) {
      try {
        connection.enqueue(event);
      } catch (error) {
        this.#logger.error(
          `Broadcast to node ${connection.nodeId} failed: ${(error as Error).message}`
        );
      }
    }
  }

  #handlers(): grpc.UntypedServiceImplementation {
    const coordinator = this.#options.coordinator;
    const registry = this.#options.registry;
    const logger = this.#logger;
    const keepaliveIntervalMs = this.#options.keepaliveIntervalMs ?? 5000;

    const validateNodeId = (nodeId: unknown): string | null => {
      if (typeof nodeId !== 'string' || !idPattern.test(nodeId)) {
        return 'nodeId must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}';
      }
      return nodeId;
    };

    return {
      /**
       * Admin revocation — canonical-first (see Coordinator.add).
       */
      Add: (
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        const item = call.request?.item;
        try {
          const result = coordinator.add(item);
          // Never log the raw item — it is a bearer secret.
          callback(null, {
            success: result.success,
            message: result.message,
            lsn: String(result.lsn),
          });
        } catch (error) {
          if (error instanceof ValidationError) {
            callback({ code: grpc.status.INVALID_ARGUMENT, message: error.message });
            return;
          }
          logger.error(`Coordinator Add failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },

      /**
       * Revocation check against the coordinator's own filter (admin/debug).
       */
      Has: (
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        const item = call.request?.item;
        const invalid = itemValidationError(item);
        if (invalid) {
          callback({ code: grpc.status.INVALID_ARGUMENT, message: invalid });
          return;
        }
        try {
          callback(null, { exists: coordinator.has(item) });
        } catch (error) {
          logger.error(`Coordinator Has failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },

      /**
       * Core metrics + coordinator cluster state.
       */
      GetMetrics: (
        _call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        try {
          const metrics = coordinator.getMetrics();
          callback(null, {
            currentCount: metrics.estimatedMetrics.currentCount,
            previousCount: metrics.estimatedMetrics.previousCount,
            currentFpRate: metrics.estimatedMetrics.currentFpRate,
            previousFpRate: metrics.estimatedMetrics.previousFpRate,
            numItems: metrics.configuration.numItems,
            fpRate: metrics.configuration.fpRate,
            rotateTime: metrics.configuration.rotateTime,
            generation: metrics.generation,
            lastLsn: String(metrics.lastLsn),
          });
        } catch (error) {
          logger.error(`Coordinator GetMetrics failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },

      /**
       * Bootstrap snapshot: blobs + consistency point + geometry.
       */
      GetSnapshot: (
        _call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        try {
          const snapshot = coordinator.getSnapshot();
          callback(null, {
            currentBlob: snapshot.currentBlob,
            previousBlob: snapshot.previousBlob,
            generation: snapshot.generation,
            lastBackupLsn: String(snapshot.lastBackupLsn),
            numItems: snapshot.numItems,
            fpRate: snapshot.fpRate,
            k: snapshot.k,
            rotateTime: snapshot.rotateTime,
          });
        } catch (error) {
          logger.error(`Coordinator GetSnapshot failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },

      /**
       * Primary replication channel: backlog drain → live events →
       * keepalives, all serialized on the node's single-writer queue.
       */
      Subscribe: (call: grpc.ServerWritableStream<any, any>): void => {
        const nodeId = validateNodeId(call.request?.nodeId);
        if (!nodeId) {
          call.emit('error', {
            code: grpc.status.INVALID_ARGUMENT,
            message: 'nodeId must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',
          });
          return;
        }
        const requestedLsn = toLsn(call.request?.lastLsn);
        if (requestedLsn === null) {
          call.emit('error', {
            code: grpc.status.INVALID_ARGUMENT,
            message: 'lastLsn must be a non-negative integer',
          });
          return;
        }

        // Retention floor: the requested backlog is no longer servable.
        if (!coordinator.canServeFrom(requestedLsn)) {
          logger.warn(
            `Node ${nodeId} requested lsn ${requestedLsn} below the retention floor — resnapshot required`
          );
          call.write({ resnapshot: { generation: coordinator.generation } });
          call.end();
          return;
        }

        const cleanup = (): void => {
          this.#connections.delete(connection);
          try {
            registry.unregisterNode(nodeId);
          } catch {
            // Registry already destroyed (shutdown race) — nothing to do.
          }
          logger.info(`Node ${nodeId} disconnected`);
        };

        const connection = new NodeConnectionImpl(
          call,
          nodeId,
          requestedLsn,
          registry,
          logger,
          cleanup
        );

        try {
          registry.registerNode(nodeId, connection);
        } catch (error) {
          // Duplicate active stream for this nodeId — operator error.
          call.emit('error', {
            code: grpc.status.ALREADY_EXISTS,
            message: (error as Error).message,
          });
          return;
        }

        this.#connections.add(connection);
        logger.info(`Node ${nodeId} subscribed from lsn ${requestedLsn}`);

        // Drain the backlog on the node's queue, then live events follow in
        // chain order — no reordering is possible between the two.
        connection.enqueueTask(async () => {
          let from = requestedLsn;
          while (!connection.closed) {
            const batch = coordinator.readSince(from, DRAIN_BATCH_SIZE);
            if (batch.length === 0) {
              break;
            }
            for (const event of batch) {
              if (connection.closed) {
                return;
              }
              await connection.writeDirect(event);
              from = event.lsn;
            }
          }
        });

        connection.startKeepalive(keepaliveIntervalMs);

        call.on('cancelled', () => connection.close());
        call.on('close', () => connection.close());
      },

      /**
       * Degraded-mode unary catch-up: same events as Subscribe, paged.
       */
      PollDeltas: (
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        const nodeId = validateNodeId(call.request?.nodeId);
        if (!nodeId) {
          callback({
            code: grpc.status.INVALID_ARGUMENT,
            message: 'nodeId must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',
          });
          return;
        }
        const fromLsn = toLsn(call.request?.fromLsn);
        if (fromLsn === null) {
          callback({
            code: grpc.status.INVALID_ARGUMENT,
            message: 'fromLsn must be a non-negative integer',
          });
          return;
        }

        try {
          if (!coordinator.canServeFrom(fromLsn)) {
            callback(null, {
              events: [{ resnapshot: { generation: coordinator.generation } }],
              moreAvailable: false,
            });
            return;
          }
          const requested = toLsn(call.request?.maxEvents);
          const maxEvents = Math.min(
            requested !== null && requested > 0 ? requested : DRAIN_BATCH_SIZE,
            MAX_POLL_EVENTS
          );
          const batch = coordinator.readSince(fromLsn, maxEvents + 1);
          const moreAvailable = batch.length > maxEvents;
          const events = batch.slice(0, maxEvents).map(toStreamEvent);
          callback(null, { events, moreAvailable });
        } catch (error) {
          logger.error(`Coordinator PollDeltas failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },

      /**
       * Cluster observability.
       */
      ListNodes: (
        _call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
      ): void => {
        try {
          const nodes = registry.listNodes().map((node) => ({
            nodeId: node.nodeId,
            lastLsn: String(node.lastLsn),
            lastSeenMs: String(node.lastSeenMs),
            connected: node.connected,
          }));
          callback(null, { nodes });
        } catch (error) {
          logger.error(`Coordinator ListNodes failed: ${(error as Error).message}`);
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        }
      },
    };
  }

  /**
   * Graceful shutdown: close every node stream (tryShutdown cannot complete
   * while server-streaming calls stay open), then tryShutdown with a
   * forceShutdown fallback — mirrors core's stopServer.
   */
  async stop(timeout = 5000): Promise<void> {
    this.#options.coordinator.setListener(null);

    for (const connection of Array.from(this.#connections)) {
      connection.close();
    }
    this.#connections.clear();
    try {
      this.#options.registry.destroy();
    } catch {
      // Registry may never have been initialized (failed start).
    }

    const server = this.#server;
    this.#server = null;
    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => {
      const forceShutdown = setTimeout(() => {
        server.forceShutdown();
        this.#logger.info('Coordinator gRPC server forcefully shutdown');
        resolve();
      }, timeout);

      server.tryShutdown(() => {
        clearTimeout(forceShutdown);
        this.#logger.info('Coordinator gRPC server gracefully shutdown');
        resolve();
      });
    });
  }
}
