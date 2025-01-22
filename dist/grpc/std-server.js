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
}

/**
 * Unregisters a Revoker instance from management by gRPC.
 * @param {string} revokerId - The ID of the Revoker instance to unregister.
 * @returns {void}
 */
export function unregisterRevokerInstance(revokerId) {
  revokerInstances.delete(revokerId);
}

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
    const { revokerId, filterItem } = call.request;
    const revokerInstance = revokerInstances.get(revokerId);
    if (revokerInstance) {
      try {
        revokerInstance.add(filterItem);
        callback(null, { success: true });
      } catch (error) {
        callback(null, { success: false, message: error.message });
      }
    } else {
      callback(null, { success: false, message: 'Revoker instance not found' });
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
    if (revokerInstance && revokerInstance.bloomFilterManager) {
      try {
        const exists = revokerInstance.bloomFilterManager.has(item);
        callback(null, { exists });
      } catch (error) {
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    } else {
      callback({ code: grpc.status.NOT_FOUND, message: 'Revoker instance or Bloom filter not found' });
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
    if (revokerInstance) {
      try {
        const metrics = revokerInstance.getMetrics();
        callback(null, {
          estimatedMetrics: metrics.estimatedMetrics,
          configuration: metrics.configuration
        });
      } catch (error) {
        callback({ code: grpc.status.INTERNAL, message: error.message });
      }
    } else {
      callback({ code: grpc.status.NOT_FOUND, message: 'Revoker instance not found' });
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
    if (revokerInstance) {
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.resetAndRestore(),
        timeout
      ]).then(() => {
        callback(null, { success: true });
      }).catch(error => {
        callback(null, { success: false, message: error.message });
      });
    } else {
      callback(null, { success: false, message: 'Revoker instance not found' });
    }
  },
  /**
   * @param {grpc.ServerUnaryCall<any, any>} call
   * @param {grpc.sendUnaryData<any>} callback
   * @returns {void}
   */
    ResetAndClearData: (call, callback) => {
    const { revokerId } = call.request;
    const revokerInstance = revokerInstances.get(revokerId);
    if (revokerInstance) {
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000)
      );
      
      Promise.race([
        revokerInstance.resetAndClearData(),
        timeout
      ]).then(() => {
        callback(null, { success: true });
      }).catch(error => {
        callback(null, { success: false, message: error.message });
      });
    } else {
      callback(null, { success: false, message: 'Revoker instance not found' });
    }
  },
  /**
   * @param {grpc.ServerUnaryCall<any, any>} call
   * @param {grpc.sendUnaryData<any>} callback
   * @returns {void}
   */
  Destroy: (call, callback) => {
    const { revokerId } = call.request;
    const revokerInstance = revokerInstances.get(revokerId);
    if (revokerInstance) {
      revokerInstance.destroy();
      unregisterRevokerInstance(revokerId);
      callback(null, { success: true });
    } else {
      callback(null, { success: false, message: 'Revoker instance not found' });
    }
  },
  /**
   * @param {grpc.ServerUnaryCall<any, any>} call
   * @param {grpc.sendUnaryData<any>} callback
   * @returns {void}
   */
  ListRevokers: (call, callback) => {
    const revokerIds = Array.from(revokerInstances.keys());
    callback(null, { revokerIds });
  },

};

/**
 * Starts the gRPC server.
 * @param {string} port - The port on which the server should listen.
 * @returns {void}
 */
export function startServer(port) {
  const server = new grpc.Server();
  server.addService(revokerProto.RevokerAdmin.service, revokerService);
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error(`Failed to bind server: ${err.message}`);
      return;
    }
    console.log(`gRPC server listening on ${port}`);
  });
}