// @ts-check

import { BloomFilterManager } from "./Bloom-filter-manager.js";
import { createJWTMiddleware, createOpaqueMiddleware } from "./createMiddlewares.js";
import { ValidationError, InternalError } from './errors.js';
import throttle from "throttleit";
import { stopServerIfLastId, registerRevokerInstance, startServer, unregisterRevokerInstance } from "./grpc/std-server.js";
import { revokerInputSchema } from "./Inputs-validation.js";

import './types.js';

/**
 * @typedef {import('./types.js').GenericLogger} GenericLogger
 * @typedef {import('express').RequestHandler} RequestHandler
*/

/**
 * Revoker class to manage middleware and adding items to the Bloom filter.
 */
export class Revoker {
  
  /** @type {BloomFilterManager | null} */
  bloomFilterManager = null;

  /** @type {RequestHandler | null} */
  middleware = null;

  /** @type {string} */
  id;

  /** @type {GenericLogger} */
  logger;

  /** @type {boolean} */
  grpcEnabled;

  /** @type {number} */
  grpcPort;

  /** @types  {Function} */
  startServer;

  /** @types  {Function} */
  registerRevokerInstance;

  /** @types  {Function} */
  unregisterRevokerInstance;

  /** @types  {Function} */
  stopServerIfLastId;

  /** @type {boolean} */
  static grpcServerStarted = false;

  /**
   * @typedef {Object} FilterConfig
   * @property {number} numItems - Number of items to store in the Bloom filter
   * @property {number} fpRate - Target false positive rate for the Bloom filter
   * @property {number} rotateTime - Rotation interval in milliseconds
   * @property {boolean} [backup] - whether to enable backup
   * @property {number} [backupTime] - Backup interval in milliseconds
   */
  
  /**
   * @typedef {Object} ConfigBase
   * @property {string} id - The ID of the Revoker instance.
   * @property {GenericLogger} logger - Any logger implementing the basic logging methods
   * @property {boolean} [grpcEnabled] - Whether to enable gRPC.
   * @property {number} [grpcPort] - The port for the gRPC server.
   * @property {FilterConfig} filter - Configuration options for the Bloom filter.
   * @typedef {ConfigBase & { claimsToCheck: Array<string>, payloadKey: string, opaqueHeader?: never }} JWTConfig
   * @typedef {ConfigBase & { opaqueHeader: string, claimsToCheck?: never, payloadKey?: never }} OpaqueConfig
   * @typedef {JWTConfig | OpaqueConfig} Config
   */
  /**
   * @typedef {Object} gRPCFunctions
   * @property {Function} [startServerFn] - Function to start the gRPC server.
   * @property {Function} [registerRevokerInstanceFn] - Function to register a Revoker instance.
   * @property {Function} [unregisterRevokerInstanceFn] - Function to unregister a Revoker instance.
   * @property {Function} [stopServerIfLastIdFn] - Function to stop the gRPC server if the last ID is removed.
   */

  /**
   * @param {Config} config - Configuration options.
   * @param {gRPCFunctions} [grpcFunctions] - Functions for gRPC server management.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  constructor(config, {
    startServerFn = startServer,
    registerRevokerInstanceFn = registerRevokerInstance,
    unregisterRevokerInstanceFn = unregisterRevokerInstance,
    stopServerIfLastIdFn = stopServerIfLastId
    } = {}) 
  {

    const { error } = revokerInputSchema.validate(config);
    if (error) {
      throw new ValidationError(`Invalid input: ${error.message}`);
    }

    const {
      id, claimsToCheck, payloadKey, opaqueHeader, grpcEnabled = false, grpcPort, logger = console, filter
    } = config;   

    try {
      this.bloomFilterManager = new BloomFilterManager({ id, logger, ...filter });
    } catch (error) {
      throw new InternalError(`Failed to initialize BloomFilterManager: ${error.message}`);
    }

    const throttleLog = throttle((message) => logger.info(message), 60000);

    this.id = id;
    this.logger = logger;

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(
        claimsToCheck,
        payloadKey,
        this.bloomFilterManager,
        logger,
        throttleLog
      );
    } else if (opaqueHeader) {
      this.middleware = createOpaqueMiddleware(
        opaqueHeader,
        this.bloomFilterManager,
        logger,
        throttleLog,
      );
    } else {
      this.bloomFilterManager.destroy();
      throw new ValidationError("claimsToCheck or opaqueHeader must be provided");
    }

    this.grpcEnabled = grpcEnabled;
    this.grpcPort = grpcPort ? Number(grpcPort) : 0;

    this.startServer = startServerFn;
    this.registerRevokerInstance = registerRevokerInstanceFn;
    this.unregisterRevokerInstance = unregisterRevokerInstanceFn;
    this.stopServerIfLastId = stopServerIfLastIdFn;


  }

  /**
   * Initializes the grpc server.
   * @returns {Promise<Revoker>} The Revoker instance.
   * @throws {Error} If the gRPC server is already started.
   * @throws {Error} If the gRPC server fails to start.
   */
  async _grpcInit() {
    if (this.grpcEnabled && this.grpcPort) {
      if (!Revoker.grpcServerStarted) {
        this.logger.info(`Starting gRPC server with id: ${this.id}`);
        this.logger.info(`grpcEnabled: ${this.grpcEnabled}`);
        try {
          await this.startServer(this.grpcPort, this.logger);
          this.registerRevokerInstance(this);
          Revoker.grpcServerStarted = true;
        } catch (error) {
          this.destroy(); // Cleanup
          this.logger.error(`Failed to start gRPC server: ${error.message}`); // double log ???
          throw new Error(`Failed to start gRPC server: ${error.message}`);
        }
      } else {
        this.logger.info("gRPC server is already started.");
        this.registerRevokerInstance(this);
      }
    }
    return this;
  }

  /**
   * Returns the configured middleware.
   * @returns {RequestHandler} Middleware Express.
   * @throws {Error} If the middleware is not configured.
   */
  getMiddleware() {
    if (!this.middleware) {
      throw new Error("Middleware not configured");
    }
    return this.middleware;
  }

  /**
   * Adds an item to the Bloom filter.
   * @param {string} filterItem - The item to add.
   * @returns {void}
   * @throws {Error} If the item is invalid.
   */
  add(filterItem) {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    try {
      this.bloomFilterManager.add(filterItem);
    } catch (error) {
      this.logger.error('Error in Revoker.add:', error);
      throw error;
    }
  }

  /**
   * Checks if an item exists in the Bloom filter.
   * @param {string} item - The item to check.
   * @returns {boolean} True if the item may exist, false otherwise.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  has(item) {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    try {
      return this.bloomFilterManager.has(item);
    } catch (error) {
      this.logger.error('Error in Revoker.has:', error);
      throw error;
    }
  }

  /**
   * Get metrics for the Bloom filter.
   * @returns {Object} Metrics object.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  getMetrics() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    return this.bloomFilterManager.getMetrics();
  }

  /**
   * Resets and restore the Bloom filter.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs during the reset or restoration.
   */
  async resetAndRestore() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }

    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }

    try {
      await this.bloomFilterManager.resetAndRestore();
      this.logger.info("Bloom filter has been reset and restored successfully.");
    } catch (error) {
      this.logger.error('Error in Revoker.resetAndRestore:', error);
      throw error;
    }
  }

  /**
   * Resets the Bloom filter and clears data.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs during the reset or data clearance.
   */
  async resetAndClearData() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }

    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }

    try {
      await this.bloomFilterManager.resetAndClearData();
      this.logger.info("Bloom filter has been reset and data cleared successfully.");
    } catch (error) {
      this.logger.error('Error in revoker.resetAndClearData:', error);
      throw error;
    }
  }

  /**
   * Destroys the Bloom filter manager.
   * @returns {Promise<void>}
   */
  async destroy() {
    try {
      if (this.grpcEnabled && Revoker.grpcServerStarted) {
        this.unregisterRevokerInstance(this.id);
        this.logger.info("Stopping gRPC server");
        await this.stopServerIfLastId(this.logger);
        this.grpcEnabled = false;
        Revoker.grpcServerStarted = false;
      }
      if (this.bloomFilterManager) {
        this.bloomFilterManager.destroy();
        this.middleware = null;
        this.bloomFilterManager = null;
      } else {
        this.logger.warn("Bloom filter manager already destroyed");
      }
    } catch (error) {
      this.logger.error("Error during Revoker destruction:", error);
      throw new InternalError(`Failed to destroy Revoker: ${error.message}`);
    }
  }
}

/**
 * Creates a Revoker instance.
 * @param {Config} config - Configuration options.
 * @param {gRPCFunctions} [grpcFunctions] - Functions for gRPC server management.
 * @returns {Promise<Revoker>} The Revoker instance.
 * @throws {Error} If the configuration is invalid.
 * @throws {Error} If the gRPC server fails to start.
 */
export async function createRevoker(config, grpcFunctions = {}) {
  const revoker = new Revoker(config, grpcFunctions);
  return await revoker._grpcInit();
}

