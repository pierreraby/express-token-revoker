// @ts-check
import '../types.js';

/**
 * @typedef {import('../types.js').GenericLogger} GenericLogger
 * @typedef {import('../types.js').RevokerStore} RevokerStore
 * @typedef {import('../index.js').Revoker} Revoker
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

// Define error message because it is used in multiple places
const REVOKER_OR_FILTER_NOT_FOUND_MSG = 'Revoker instance or Bloom filter not found';

/**
 * Server Global variable
 * @type {grpc.Server | null}
 * @private
 **/
let server = null;

/**
 * Starts the gRPC server.
 * @param {number} port - The port on which the server should listen.
 * @param {RevokerStore} revokerStore - The RevokerStore instance.
 * @param {GenericLogger} logger - The logger instance.
 * @returns {Promise<void>}
 */
export function startServer(port, revokerStore, logger) {
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);
      
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);
      
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);
      
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }
      let timeout;
      const timeoutPromise = new Promise((_, reject) => 
        timeout = setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.bloomFilterManager.resetAndRestore(),
        timeoutPromise
      ]).then(() => {
        logger.info(`Bloom filter reset and restored for revoker ${revokerId}`);
        clearInterval(timeout);
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
      const revokerInstance = revokerStore.findInstance(revokerId, logger);
      
      if (!revokerInstance) {
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }
      let timeout;
      const timeoutPromise = new Promise((_, reject) => 
        timeout = setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.bloomFilterManager.resetAndClearData(),
        timeoutPromise
      ]).then(() => {
        logger.info(`Bloom filter reset and data cleared for revoker ${revokerId}`);
        clearInterval(timeout);
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
        const revokerIds = revokerStore.listInstances();
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
 export async function stopServer(logger =console, timeout = 5000) {
  if (server) {
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
