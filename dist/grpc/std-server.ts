import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
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
  code: number;
  success: boolean;
  message: string;
}
interface HasResponse {
  code: number;
  exists: boolean;
}
interface MetricsResponse {
  code: number;
  estimatedMetrics: EstimatedMetrics;
  configuration: Configuration;
}
interface ListResponse {
  code: number;
  revokerIds: string[];
}

/**
 * Server Global variable
 */
let server: grpc.Server | null = null;

/**
 * Starts the gRPC server.
 * @param port - The port on which the server should listen.
 * @param revokerStore - The RevokerStore instance.
 * @param logger - The logger instance.
 */
export function startServer(
  port: number,
  revokerStore: RevokerStore,
  logger: GenericLogger
): Promise<void> {
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
      }

      try {
        revokerInstance.bloomFilterManager.add(item);
        logger.info(`Item ${item} added to Bloom filter for revoker ${revokerId}`);
        callback(null, {
          code: grpc.status.OK,
          success: true,
          message: 'Item added to Bloom filter',
        });
      } catch (error) {
        logger.error(
          `Error adding item to Bloom filter for revoker ${revokerId}: ${error.message}`
        );
        callback({ code: grpc.status.INTERNAL, message: error.message });
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);

      if (!revokerInstance) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
      }

      try {
        const exists = revokerInstance.bloomFilterManager.has(item);
        logger.info(`Item ${item} checked in Bloom filter for revoker ${revokerId}`);
        callback(null, { code: grpc.status.OK, exists });
      } catch (error) {
        logger.error(
          `Error checking item in Bloom filter for revoker ${revokerId}: ${error.message}`
        );
        callback({ code: grpc.status.INTERNAL, message: error.message });
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
        return callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
      }

      try {
        const metrics = revokerInstance.bloomFilterManager.getMetrics();
        logger.info(`Metrics retrieved for Bloom filter of revoker ${revokerId}`);
        callback(null, {
          code: grpc.status.OK,
          estimatedMetrics: metrics.estimatedMetrics,
          configuration: metrics.configuration,
        });
      } catch (error) {
        logger.error(
          `Error retrieving metrics for Bloom filter of revoker ${revokerId}: ${error.message}`
        );
        callback({ code: grpc.status.INTERNAL, message: error.message });
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
        return callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
      }
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise(
        (_, reject) => (timeout = setTimeout(() => reject(new Error('Timeout')), 5000))
      );

      Promise.race([revokerInstance.bloomFilterManager.resetAndRestore(), timeoutPromise])
        .then(() => {
          logger.info(`Bloom filter reset and restored for revoker ${revokerId}`);
          clearInterval(timeout);
          callback(null, {
            code: grpc.status.OK,
            success: true,
            message: 'Bloom filter reset and restored',
          });
        })
        .catch((error) => {
          logger.error(
            `Error resetting and restoring Bloom filter for revoker ${revokerId}: ${error.message}`
          );
          callback({ code: grpc.status.INTERNAL, message: error.message });
        });
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
        return callback({
          code: grpc.status.NOT_FOUND,
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG,
        });
      }
      let timeout: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise(
        (_, reject) => (timeout = setTimeout(() => reject(new Error('Timeout')), 5000))
      );

      Promise.race([revokerInstance.bloomFilterManager.resetAndClearData(), timeoutPromise])
        .then(() => {
          logger.info(`Bloom filter reset and data cleared for revoker ${revokerId}`);
          clearInterval(timeout);
          callback(null, {
            code: grpc.status.OK,
            success: true,
            message: 'Bloom filter reset and data cleared',
          });
        })
        .catch((error) => {
          logger.error(
            `Error resetting and clearing data for Bloom filter for revoker ${revokerId}: ${error.message}`
          );
          callback({ code: grpc.status.INTERNAL, message: error.message });
        });
    },
    /**
     * Lists all Revoker instances.
     */
    ListRevokers: (
      call: grpc.ServerUnaryCall<null, ListResponse>,
      callback: grpc.sendUnaryData<ListResponse>
    ): void => {
      try {
        const revokerIds = revokerStore.listInstances();
        callback(null, { code: grpc.status.OK, revokerIds });
      } catch (error) {
        console.error(`Error listing revokers: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
  };

  server = new grpc.Server();
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      return reject(new Error('Server is not initialized'));
    }
    server.addService(revokerProto.RevokerAdmin.service, revokerService);
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err, bindPort) => {
        if (err) {
          logger.error(`Failed to bind server: ${err.message}`);
          return reject(err);
        }
        logger.info(`gRPC server listening on ${bindPort}`);
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
