// @ts-check
import '../types.js';

/**
 * @typedef {import('../types.js').GenericLogger} GenericLogger
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.join(__dirname, './protos/revoker.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const revokerProto = protoDescriptor.revoker;

/**
 * @typedef {import('../index.js').Revoker} Revoker
 */

// Use an object to store Revoker instances
/** @type {Map<string, Revoker> | null} */
let revokerInstances = new Map();

/**
 * Registers a Revoker instance for management by gRPC.
 * @param {Revoker} revokerInstance - The Revoker instance to register.
 * @returns {void}
 * @throws {Error} If the Revoker instances map is not initialized.
 */
export function registerRevokerInstance(revokerInstance) {
  if (revokerInstances) {
    revokerInstances.set(revokerInstance.id, revokerInstance);
    revokerInstance.logger.info(`Revoker instance ${revokerInstance.id} registered`);
  } else {
    throw new Error('Revoker instances map is not initialized');
  }
}

/**
 * Unregisters a Revoker instance from management by gRPC.
 * @param {string} revokerId - The ID of the Revoker instance to unregister.
 * @returns {void}
 */
export function unregisterRevokerInstance(revokerId) {
  if (revokerInstances) {
    revokerInstances.delete(revokerId);
  } else {
    throw new Error('Revoker instances map is not initialized');
  }
}

// Define error message because it is used in multiple places
const REVOKER_OR_FILTER_NOT_FOUND_MSG = 'Revoker instance or Bloom filter not found';


/**
 * Checks if a revokerInstance has a non-null bloomFilterManager.
 * @param {Revoker | undefined} revokerInstance
 * @returns {revokerInstance is Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }}
 */
function hasNonNullableBloomFilterManager(revokerInstance) {
  return !!revokerInstance && !!revokerInstance.bloomFilterManager;
}

/**
 * Finds a Revoker instance by ID.
 * @param {string} revokerId - The ID of the Revoker instance.
 * @param {GenericLogger} logger - The logger instance.
 * @returns {(Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }) | undefined}
 */
function findRevokerInstance(revokerId, logger) {
  const revokerInstance = revokerInstances ? revokerInstances.get(revokerId) : undefined;
  if (!hasNonNullableBloomFilterManager(revokerInstance)) {
    logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
    return undefined;
  }
  return revokerInstance;
}

/**
 * Server Global variable
 * @type {grpc.Server | null}
 * @private
 **/
let server = null;

/**
 * Starts the gRPC server.
 * @param {number} port - The port on which the server should listen.
 * @param {GenericLogger} logger - The logger instance.
 * @returns {Promise<void>}
 */
export function startServer(port, logger) {
  /**
   * Implements the gRPC RevokerAdmin service.
   */
  const revokerService = {
    /**
     * Adds an item to the Bloom filter.
     * @param {grpc.ServerUnaryCall<{ revokerId: string, item: string }, { code: number, success: boolean, message: string }>} call - The gRPC call object for the Add method.
     * @param {grpc.sendUnaryData<{ code: number, success: boolean, message: string }>} callback - The gRPC callback function for the Add method.
     * @returns {void}
     */
    Add: (call, callback) => {
      const { revokerId, item } = call.request;
      const revokerInstance = findRevokerInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }
    
      try {
        revokerInstance.bloomFilterManager.add(item);
        logger.info(`Item ${item} added to Bloom filter for revoker ${revokerId}`);
        callback(null, { code: grpc.status.OK, success: true, message: 'Item added to Bloom filter' });
      } catch (error) {
        logger.error(`Error adding item to Bloom filter for revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    /**
     * Checks if an item exists in the Bloom filter.
     * @param {grpc.ServerUnaryCall<{ revokerId: string, item: string }, { code: number, exists: boolean }>} call - The gRPC call object for the Has method.
     * @param {grpc.sendUnaryData<{ code: number, exists: boolean }>} callback - The gRPC callback function for the Has method.
     * @returns {void}
     */
    Has: (call, callback) => {
      const { revokerId, item } = call.request;
      const revokerInstance = findRevokerInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }
    
      try {
        const exists = revokerInstance.bloomFilterManager.has(item);
        logger.info(`Item ${item} checked in Bloom filter for revoker ${revokerId}`);
        callback(null, {code: grpc.status.OK, exists});
      } catch (error) {
        logger.error(`Error checking item in Bloom filter for revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    /**
     * Retrieves metrics for the Bloom filter.
     * @param {grpc.ServerUnaryCall<{ revokerId: string }, { code: number, estimatedMetrics: Object, configuration: Object }>} call - The gRPC call object for the GetMetrics method.
     * @param {grpc.sendUnaryData<{ code: number, estimatedMetrics: Object, configuration: Object }>} callback - The gRPC callback function for the GetMetrics method.
     * @returns {void}
     */
    GetMetrics: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = findRevokerInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }

      try {
        const metrics = revokerInstance.bloomFilterManager.getMetrics();
        logger.info(`Metrics retrieved for Bloom filter of revoker ${revokerId}`);
        callback(null, {code: grpc.status.OK,
          estimatedMetrics: metrics.estimatedMetrics,
          configuration: metrics.configuration
        });
      } catch (error) {
        logger.error(`Error retrieving metrics for Bloom filter of revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    /**
     * Resets and restores the Bloom filter.
     * @param {grpc.ServerUnaryCall<{ revokerId: string }, { code: number, success: boolean, message: string }>} call - The gRPC call object for the ResetAndRestore method.
     * @param {grpc.sendUnaryData<{ code: number, success: boolean, message: string }>} callback - The gRPC callback function for the ResetAndRestore method.
     * @returns {void}
     */
    ResetAndRestore: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = findRevokerInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }

      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.bloomFilterManager.resetAndRestore(),
        timeout
      ]).then(() => {
        logger.info(`Bloom filter reset and restored for revoker ${revokerId}`);
        callback(null, { code: grpc.status.OK, success: true, message: 'Bloom filter reset and restored' });
      }).catch(error => {
        logger.error(`Error resetting and restoring Bloom filter for revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      });
    },
    /**
     * Resets the Bloom filter and clears its data.
     * @param {grpc.ServerUnaryCall<{ revokerId: string }, { code: number, success: boolean, message: string }>} call - The gRPC call object for the ResetAndClearData method.
     * @param {grpc.sendUnaryData<{ code: number, success: boolean, message: string }>} callback - The gRPC callback function for the ResetAndClearData method.
     * @returns {void}
     */
      ResetAndClearData: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = findRevokerInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }

      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.bloomFilterManager.resetAndClearData(),
        timeout
      ]).then(() => {
        logger.info(`Bloom filter reset and data cleared for revoker ${revokerId}`);
        callback(null, { code: grpc.status.OK, success: true, message: 'Bloom filter reset and data cleared' }); 
      }).catch(error => {
        logger.error(`Error resetting and clearing data for Bloom filter for revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      });
    },
    /**
     * Lists all Revoker instances.
     * @param {grpc.ServerUnaryCall<null, { code: number, revokerIds: string[] }>} call - The gRPC call object for the ListRevokers method.
     * @param {grpc.sendUnaryData<{ code: number, revokerIds: string[] }>} callback - The gRPC callback function for the ListRevokers method.
     * @returns {void}
     */
    ListRevokers: (call, callback) => {
      try {
        const revokerIds = revokerInstances ? Array.from(revokerInstances.keys()) : [];
        callback(null, { code: grpc.status.OK, revokerIds });
      } catch (error) {
        console.error(`Error listing revokers: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
  };

  server = new grpc.Server();
  return new Promise((resolve, reject) => {
    if (!server) {
      return reject(new Error('Server is not initialized'));
    }
    // @ts-ignore : the protoLoader does not generate types for the service
    server.addService(revokerProto.RevokerAdmin.service, revokerService);
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, bindPort) => {
      if (err) {
        logger.error(`Failed to bind server: ${err.message}`);
        return reject(err);
      }
      logger.info(`gRPC server listening on ${bindPort}`);
      resolve();
    });
  });
}

 /**
   * Gracefully shutdown the gRPC server
   * @param {GenericLogger} logger - The logger instance
   * @param {number} [timeout=5000] Timeout in ms to force shutdown
   * @returns {Promise<void>} 
   */
 export async function stopServerIfLastId(logger =console, timeout = 5000) {
  if (server && revokerInstances && revokerInstances.size === 0) {
    revokerInstances = null;
    const currentServer = server;

    return new Promise((resolve) => {
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
