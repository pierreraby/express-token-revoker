import { ValidationError } from 'express-token-revoker';
import { Coordinator } from './coordinator.js';
import { DistributedServer } from './distributedServer.js';
import { NodeRegistry } from './nodeRegistry.js';
import { type CoordinatorConfig, coordinatorInputSchema } from './validation.js';

/**
 * A started coordinator: the wrapped revoker, the gRPC service and the
 * bound port, plus the shutdown entry points.
 */
export interface CoordinatorHandle {
  /** The coordinator instance (admin operations: add/has/getMetrics/rotate/snapshot). */
  coordinator: Coordinator;
  /** The distributed gRPC service. */
  server: DistributedServer;
  /** The port actually bound (may differ from config.port when port 0 is used). */
  port: number;
  /** Graceful shutdown: server first (streams + gRPC), then the coordinator. */
  shutdown(): Promise<void>;
}

/**
 * Creates and starts a distributed revocation coordinator.
 *
 * The coordinator wraps a core Revoker (backup enabled, gRPC disabled),
 * owns the canonical WAL and the rotation schedule, and serves the
 * RevokerCoordinator gRPC service (distributed.proto) to participant nodes
 * and admin callers.
 *
 * @param config - Coordinator configuration (validated with Joi).
 * @returns A handle exposing the coordinator, the server and shutdown.
 * @throws {ValidationError} If the configuration is invalid (including an
 * incomplete auth block) or the bind is refused (insecure + non-loopback).
 * @throws {InternalError} If the coordinator fails to start.
 */
export async function createCoordinator(config: CoordinatorConfig): Promise<CoordinatorHandle> {
  const { error, value } = coordinatorInputSchema.validate(config, {
    abortEarly: false,
    allowUnknown: false,
  });
  if (error) {
    throw new ValidationError(`Invalid coordinator config: ${error.message}`);
  }
  const validated = value as CoordinatorConfig;

  const coordinator = new Coordinator(validated);
  const registry = new NodeRegistry();
  const server = new DistributedServer({
    coordinator,
    registry,
    logger: validated.logger ?? console,
    host: validated.host,
    port: validated.port,
    auth: validated.auth,
    keepaliveIntervalMs: validated.keepaliveIntervalMs,
  });

  let port = 0;
  try {
    await coordinator.init();
    port = await server.start();
  } catch (error) {
    // Cleanup whatever came up so a failed start never leaks intervals,
    // file handles or a half-bound server (core's grpc-bind lesson).
    try {
      await server.stop();
    } catch {
      // Best effort — the primary failure is reported below.
    }
    try {
      await coordinator.shutdown();
    } catch {
      // Best effort.
    }
    throw error;
  }

  return {
    coordinator,
    server,
    port,
    async shutdown(): Promise<void> {
      await server.stop();
      await coordinator.shutdown();
    },
  };
}

// Re-export core's error classes so consumers of the server package do not
// need a second import for catch blocks.
export { InternalError, ValidationError } from 'express-token-revoker';
export type { CanonicalWalOptions, CanonicalWalScan } from './canonicalWal.js';
export { CanonicalWal } from './canonicalWal.js';
export type { AddResult, LiveEventListener, SnapshotData } from './coordinator.js';
export { Coordinator, itemValidationError, MAX_ITEM_LENGTH } from './coordinator.js';
export type { DistributedServerOptions } from './distributedServer.js';
export { DistributedServer, SHARED_SECRET_METADATA_KEY } from './distributedServer.js';
export { EMPTY_META_STATE, Meta } from './meta.js';
export type { NodeConnection, NodeEntryView } from './nodeRegistry.js';
export { NodeRegistry } from './nodeRegistry.js';
export type {
  CanonicalEvent,
  GenericLogger,
  MetaState,
  OutboundEvent,
} from './types.js';
export type {
  AuthMode,
  CoordinatorAuthConfig,
  CoordinatorConfig,
  CoordinatorFilterConfig,
  CoordinatorJWTConfig,
  CoordinatorOpaqueConfig,
} from './validation.js';
export {
  AUTH_SECRET_MIN_LENGTH,
  coordinatorAuthSchema,
  coordinatorFilterSchema,
  coordinatorInputSchema,
  idPattern,
} from './validation.js';
