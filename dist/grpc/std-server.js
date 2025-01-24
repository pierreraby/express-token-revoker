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
/** @type {Map<string, Revoker>} */
const revokerInstances = new Map();

/**
 * Registers a Revoker instance for management by gRPC.
 * @param {Revoker} revokerInstance - The Revoker instance to register.
 * @returns {void}
 */
export function registerRevokerInstance(revokerInstance) {
  revokerInstances.set(revokerInstance.id, revokerInstance);
  console.log(`Revoker instance ${revokerInstance.id} registered`);
}

/**
 * Unregisters a Revoker instance from management by gRPC.
 * @param {string} revokerId - The ID of the Revoker instance to unregister.
 * @returns {void}
 */
export function unregisterRevokerInstance(revokerId) {
  revokerInstances.delete(revokerId);
}

// Define error message because it is used in multiple places
const REVOKER_OR_FILTER_NOT_FOUND_MSG = 'Revoker instance or Bloom filter not found';


/**
 * Starts the gRPC server.
 * @param {string} port - The port on which the server should listen.
 * @returns {void}
 */
export function startServer(port, logger) {
  const server = new grpc.Server();

  /**
   * Implements the gRPC RevokerAdmin service.
   */
  const revokerService = {
    /**
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    Add: (call, callback) => {
      const { revokerId, item } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);
      
      if (!revokerInstance || !revokerInstance.bloomFilterManager) {
        logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: REVOKER_OR_FILTER_NOT_FOUND_MSG
        });
      }
      console.log('item:', item);
    
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
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    Has: (call, callback) => {
      const { revokerId, item } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);
      
      if (!revokerInstance || !revokerInstance.bloomFilterManager) {
        logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
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
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    GetMetrics: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);

      if (!revokerInstance || !revokerInstance.bloomFilterManager) {
        logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
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
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    ResetAndRestore: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);

      if (!revokerInstance || !revokerInstance.bloomFilterManager) {
        logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
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
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
      ResetAndClearData: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);

      if (!revokerInstance || !revokerInstance.bloomFilterManager) {
        logger.error(REVOKER_OR_FILTER_NOT_FOUND_MSG);
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
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    Destroy: (call, callback) => {
      const { revokerId } = call.request;
      const revokerInstance = revokerInstances.get(revokerId);

      if (!revokerInstance) {
        const message = 'Revoker instance not found';
        logger.error(message);
        return callback({ 
          code: grpc.status.NOT_FOUND, 
          message: message
        });
      }
      try {
        revokerInstance.destroy();
        unregisterRevokerInstance(revokerId);
        callback(null, { code: grpc.status.OK, success: true, message: 'Revoker destroyed' });
      } catch (error) {
        logger.error(`Error destroying revoker ${revokerId}: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
    /**
     * @param {grpc.ServerUnaryCall<any, any>} call
     * @param {grpc.sendUnaryData<any>} callback
     * @returns {void}
     */
    ListRevokers: (call, callback) => {
      try {
        const revokerIds = Array.from(revokerInstances.keys());
        callback(null, { code: grpc.status.OK, revokerIds });
      } catch (error) {
        console.error(`Error listing revokers: ${error.message}`);
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    },
  };

  server.addService(revokerProto.RevokerAdmin.service, revokerService);
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      logger.error(`Failed to bind server: ${err.message}`);
      return;
    }
    logger.info(`gRPC server listening on ${port}`);
  });
}
