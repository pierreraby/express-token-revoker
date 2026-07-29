import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from '../errors.js';
import type { GenericLogger, RevokerStore } from '../types.js';
import type { EstimatedMetrics, Configuration } from '../Bloom-filter-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.join(__dirname, './protos/revoker.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
// The protoLoader does not generate types for the service
const revokerProto: any = protoDescriptor.revoker;

// Define error message because it is used in multiple places
const REVOKER_OR_FILTER_NOT_FOUND_MSG = 'Revoker instance or Bloom filter not found';

/** Maximum accepted length for a single revocation item. */
const MAX_ITEM_LENGTH = 4096;

/** Hard cap on incoming gRPC messages — admin payloads are tiny. */
const MAX_RECEIVE_MESSAGE_SIZE = 1024 * 1024; // 1 MB

/**
 * Options for the gRPC admin server.
 */
export interface GrpcServerOptions {
  /**
   * Host to bind to. Defaults to `127.0.0.1` (loopback only).
   * The admin service is unauthenticated: binding it to a non-loopback
   * address without TLS is refused unless `allowInsecureRemote` is set.
   */
  host?: string;
  /**
   * Allow binding without TLS on a non-loopback host.
   * Strongly discouraged — only for isolated/trusted networks.
   */
  allowInsecureRemote?: boolean;
}

interface AddRequest {
  revokerId: string;
  item: string;
}
interface HasRequest {
  revokerId: string;
  item: string;
}
interface RevokerIdRequest {
  revokerId: string;
}
interface AddResponse {
  success: boolean;
  message: string;
}
interface HasResponse {
  exists: boolean;
}
interface MetricsResponse {
  estimatedMetrics: EstimatedMetrics;
  configuration: Configuration;
}
interface ListResponse {
  revokerIds: string[];
}

/**
 * Validates a revocation item received over gRPC.
 * @returns An error message, or null when the item is valid.
 */
function itemValidationError(item: unknown): string | null {
  if (typeof item !== 'string' || item.length === 0) {
    return 'item must be a non-empty string';
  }
  if (item.length > MAX_ITEM_LENGTH) {
    return `item must not exceed ${MAX_ITEM_LENGTH} characters`;
  }
  // Line breaks would corrupt the write-ahead log (one token per line).
  if (/[\r\n\0]/.test(item)) {
    return 'item must not contain \\r, \\n or \\0 characters';
  }
  return null;
}

/**
 * Whether the host is a loopback address (safe for an unauthenticated admin
 * service, since only local processes can reach it).
 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Server Global variable
 */
let server: grpc.Server | null = null;

/**
 * Starts the gRPC server.
 *
 * The RevokerAdmin service is unauthenticated. By default it binds to the
 * loopback interface only; binding to a non-loopback host without TLS is
 * refused unless `options.allowInsecureRemote` is explicitly set.
 *
 * @param port - The port on which the server should listen.
 * @param revokerStore - The RevokerStore instance.
 * @param logger - The logger instance.
 * @param options - Bind options (host, insecure-remote opt-in).
 * @throws {ValidationError} If a non-loopback bind is requested without the explicit opt-in.
 */
export function startServer(
  port: number,
  revokerStore: RevokerStore,
  logger: GenericLogger,
  options: GrpcServerOptions = {}
): Promise<void> {
  const host = options.host ?? '127.0.0.1';

  if (!isLoopbackHost(host) && !options.allowInsecureRemote) {
    throw new ValidationError(
      `Refusing to bind the unauthenticated gRPC admin service to non-loopback host "${host}". ` +
        'Put TLS in front of it and keep the bind local, or set grpcAllowInsecureRemote: true ' +
        'to accept the risk on an isolated network.'
    );
  }

  /**
   * Implements the gRPC RevokerAdmin service.
   */
  const revokerService = {
    /**
     * Adds an item to the Bloom filter.
     */
    Add: (
      call: grpc.ServerUnaryCall<AddRequest, AddResponse>,
      callback: grpc.sendUnaryData<AddResponse>
    ): void => {
      const { revokerId, item } = call.request;

      const invalidItem = itemValidationError(item);
      if (invalidItem) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: invalidItem });
        return;
      }

      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
        return;
      }

      try {
        revokerInstance.bloomFilterManager.add(item);
        // Never log the raw token — it is a bearer secret.
        logger.debug(`Item added to Bloom filter for revoker ${revokerId}`);
        callback(null, {
          success: true,
          message: 'Item added to Bloom filter',
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          callback({ code: grpc.status.INVALID_ARGUMENT, message: error.message });
          return;
        }
        logger.error(
          `Error adding item to Bloom filter for revoker ${revokerId}: ${(error as Error).message}`
        );
        callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
      }
    },
    /**
     * Checks if an item exists in the Bloom filter.
     */
    Has: (
      call: grpc.ServerUnaryCall<HasRequest, HasResponse>,
      callback: grpc.sendUnaryData<HasResponse>
    ): void => {
      const { revokerId, item } = call.request;

      const invalidItem = itemValidationError(item);
      if (invalidItem) {
        callback({ code: grpc.status.INVALID_ARGUMENT, message: invalidItem });
        return;
      }

      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
        return;
      }

      try {
        const exists = revokerInstance.bloomFilterManager.has(item);
        logger.debug(`Item checked in Bloom filter for revoker ${revokerId}`);
        callback(null, { exists });
      } catch (error) {
        if (error instanceof ValidationError) {
          callback({ code: grpc.status.INVALID_ARGUMENT, message: error.message });
          return;
        }
        logger.error(
          `Error checking item in Bloom filter for revoker ${revokerId}: ${(error as Error).message}`
        );
        callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
      }
    },
    /**
     * Retrieves metrics for the Bloom filter.
     */
    GetMetrics: (
      call: grpc.ServerUnaryCall<RevokerIdRequest, MetricsResponse>,
      callback: grpc.sendUnaryData<MetricsResponse>
    ): void => {
      const { revokerId } = call.request;
      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
        return;
      }

      try {
        const metrics = revokerInstance.bloomFilterManager.getMetrics();
        logger.debug(`Metrics retrieved for Bloom filter of revoker ${revokerId}`);
        callback(null, {
          estimatedMetrics: metrics.estimatedMetrics,
          configuration: metrics.configuration,
        });
      } catch (error) {
        logger.error(
          `Error retrieving metrics for Bloom filter of revoker ${revokerId}: ${(error as Error).message}`
        );
        callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
      }
    },
    /**
     * Resets and restores the Bloom filter.
     */
    ResetAndRestore: (
      call: grpc.ServerUnaryCall<RevokerIdRequest, AddResponse>,
      callback: grpc.sendUnaryData<AddResponse>
    ): void => {
      const { revokerId } = call.request;
      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise(
        (_, reject) => (timeout = setTimeout(() => reject(new Error('Timeout')), 5000))
      );

      Promise.race([revokerInstance.bloomFilterManager.resetAndRestore(), timeoutPromise])
        .then(() => {
          logger.info(`Bloom filter reset and restored for revoker ${revokerId}`);
          callback(null, {
            success: true,
            message: 'Bloom filter reset and restored',
          });
        })
        .catch((error) => {
          logger.error(
            `Error resetting and restoring Bloom filter for revoker ${revokerId}: ${(error as Error).message}`
          );
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        })
        .finally(() => clearTimeout(timeout));
    },
    /**
     * Resets the Bloom filter and clears its data.
     */
    ResetAndClearData: (
      call: grpc.ServerUnaryCall<RevokerIdRequest, AddResponse>,
      callback: grpc.sendUnaryData<AddResponse>
    ): void => {
      const { revokerId } = call.request;
      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise(
        (_, reject) => (timeout = setTimeout(() => reject(new Error('Timeout')), 5000))
      );

      Promise.race([revokerInstance.bloomFilterManager.resetAndClearData(), timeoutPromise])
        .then(() => {
          logger.info(`Bloom filter reset and data cleared for revoker ${revokerId}`);
          callback(null, {
            success: true,
            message: 'Bloom filter reset and data cleared',
          });
        })
        .catch((error) => {
          logger.error(
            `Error resetting and clearing data for Bloom filter for revoker ${revokerId}: ${(error as Error).message}`
          );
          callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
        })
        .finally(() => clearTimeout(timeout));
    },
    /**
     * Lists all Revoker instances.
     */
    ListRevokers: (
      _call: grpc.ServerUnaryCall<null, ListResponse>,
      callback: grpc.sendUnaryData<ListResponse>
    ): void => {
      try {
        const revokerIds = revokerStore.listInstances();
        callback(null, { revokerIds });
      } catch (error) {
        logger.error(`Error listing revokers: ${(error as Error).message}`);
        callback({ code: grpc.status.INTERNAL, message: (error as Error).message });
      }
    },
  };

  server = new grpc.Server({
    'grpc.max_receive_message_size': MAX_RECEIVE_MESSAGE_SIZE,
  });
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      return reject(new Error('Server is not initialized'));
    }
    server.addService(revokerProto.RevokerAdmin.service, revokerService);
    server.bindAsync(
      `${host}:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, bindPort) => {
        if (err) {
          logger.error(`Failed to bind server on ${host}:${port}: ${err.message}`);
          return reject(err);
        }
        logger.info(`gRPC server listening on ${host}:${bindPort}`);
        resolve();
      }
    );
  });
}

/**
 * Gracefully shutdown the gRPC server
 * @param logger - The logger instance
 * @param timeout Timeout in ms to force shutdown
 */
export async function stopServer(logger: GenericLogger = console, timeout = 5000): Promise<void> {
  if (server) {
    const currentServer = server;

    return new Promise<void>((resolve) => {
      const forceShutdown = setTimeout(() => {
        if (currentServer === server) {
          server.forceShutdown();
          server = null;
        }
        logger.info('Grpc server forcefully shutdown');
        resolve();
      }, timeout);

      currentServer.tryShutdown(() => {
        clearTimeout(forceShutdown);
        if (currentServer === server) {
          server = null;
        }
        logger.info('Grpc server gracefully shutdown');
        resolve();
      });
    });
  }
  return Promise.resolve();
}
