import { BloomFilterManager } from "./Bloom-filter-manager.js";
import { createJWTMiddleware, createOpaqueMiddleware } from "./createMiddlewares.js";
import { ValidationError, InternalError } from './errors.js';
import throttle from "throttleit";
import { stopServer, startServer } from "./grpc/std-server.js";
import { revokerInputSchema } from "./Inputs-validation.js";
import RevokerStore from "./revokerStore.js";
import type { GenericLogger, RevokerStore as RevokerStoreType } from './types.js';
import type { RequestHandler } from 'express';

/**
 * Configuration options for the Bloom filter.
 */
export interface FilterConfig {
  /** Number of items to store in the Bloom filter */
  numItems: number;
  /** Target false positive rate for the Bloom filter */
  fpRate: number;
  /** Rotation interval in milliseconds */
  rotateTime: number;
  /** whether to enable backup */
  backup?: boolean;
  /** Ratio of the rotation time for backups (e.g., 4 for backup every rotateTime / 4). Defaults to no backups. */
  backupRatioTime?: number;
  /** The absolute path to the backup directory. Defaults to a 'backup' directory relative to the current file. */
  backupDir?: string;
  /** Whether to enable buffering of items to add to the Bloom filter. Defaults to false. */
  bufferEnabled?: boolean;
}

interface ConfigBase {
  /** The ID of the Revoker instance. */
  id: string;
  /** Any logger implementing the basic logging methods */
  logger: GenericLogger;
  /** Whether to enable gRPC. */
  grpcEnabled?: boolean;
  /** The port for the gRPC server. */
  grpcPort?: number;
  /** Configuration options for the Bloom filter. */
  filter: FilterConfig;
}

export type JWTConfig = ConfigBase & { claimsToCheck: string[]; payloadKey: string; opaqueHeader?: never };
export type OpaqueConfig = ConfigBase & { opaqueHeader: string; claimsToCheck?: never; payloadKey?: never };
export type Config = JWTConfig | OpaqueConfig;

/**
 * Functions for gRPC server management.
 */
export interface gRPCFunctions {
  /** Function to start the gRPC server. */
  startServerFn?: typeof startServer;
  /** Function to stop the gRPC server if the last ID is removed. */
  stopServerFn?: typeof stopServer;
}

/**
 * Revoker class to manage middleware and adding items to the Bloom filter.
 */
export class Revoker {
  bloomFilterManager: BloomFilterManager | null = null;
  middleware: RequestHandler | null = null;
  id: string;
  logger: GenericLogger;
  grpcEnabled: boolean;
  grpcPort: number;
  startServer: typeof startServer;
  stopServer: typeof stopServer;
  revokerStore: RevokerStoreType;
  static grpcServerStarted = false;

  /**
   * @param config - Configuration options.
   * @param grpcFunctions - Functions for gRPC server management.
   * @param revokerStore - The RevokerStore instance.
   * The parameters `startServerFn`, `stopServerFn`, and `revokerStore` are
   * reserved for testing and dependency injection to facilitate testing.
   * They should not be used or modified in production.
   * @throws {ValidationError} If the configuration is invalid.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  constructor(
    config: Config,
    {
      startServerFn = startServer,
      stopServerFn = stopServer
    }: gRPCFunctions = {},
    revokerStore: RevokerStoreType = RevokerStore
  ) {

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

    const throttleLog = throttle((message: string) => logger.info(message), 60000);

    this.id = id;
    this.logger = logger;

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(
        claimsToCheck,
        payloadKey!,
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
    this.stopServer = stopServerFn;
    this.revokerStore = revokerStore;

  }

  /**
   * Initializes the grpc server.
   * @returns The Revoker instance.
   * @throws {Error} If the gRPC server fails to start.
   */
  async _grpcInit(): Promise<Revoker> {
    if (this.grpcEnabled && this.grpcPort) {
      if (!Revoker.grpcServerStarted) {
        this.logger.info(`Starting gRPC server with id: ${this.id}`);
        try {
          this.revokerStore.init();
          await this.startServer(this.grpcPort, RevokerStore, this.logger);
          this.revokerStore.registerInstance(this);
          Revoker.grpcServerStarted = true;
        } catch (error) {
          this.destroy(); // Cleanup
          this.logger.error(`Failed to start gRPC server: ${error.message}`); // double log ???
          throw new Error(`Failed to start gRPC server: ${error.message}`);
        }
      } else {
        this.logger.info("gRPC server is already started.");
        this.revokerStore.registerInstance(this);
      }
    }
    return this;
  }

  /**
   * Returns the configured middleware.
   * @returns Middleware Express.
   * @throws {Error} If the middleware is not configured.
   */
  getMiddleware(): RequestHandler {
    if (!this.middleware) {
      throw new Error("Middleware not configured");
    }
    return this.middleware;
  }

  /**
   * Adds an item to the Bloom filter.
   * @param filterItem - The item to add.
   * @throws {Error} If the item is invalid.
   */
  add(filterItem: string): void {
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
   * @param item - The item to check.
   * @returns True if the item may exist, false otherwise.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  has(item: string): boolean {
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
   * @returns Metrics object.
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
   * @throws {Error} If an error occurs during the reset or restoration.
   */
  async resetAndRestore(): Promise<void> {
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
   * @throws {Error} If an error occurs during the reset or data clearance.
   */
  async resetAndClearData(): Promise<void> {
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
   */
  async destroy(): Promise<void> {
    try {
      if (this.grpcEnabled && Revoker.grpcServerStarted) {
        this.revokerStore.unregisterInstance(this.id);
        this.logger.info(`unregistering instance : ${this.id}`);
        this.grpcEnabled = false;
        if (this.revokerStore.isEmpty()) {
          this.logger.info("Stopping gRPC server");
          this.revokerStore.destroy();
          await this.stopServer(this.logger);
          Revoker.grpcServerStarted = false;
        }
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
 * @param config - Configuration options.
 * @param grpcFunctions - Functions for gRPC server management.
 * This function is **exported for testing purposes only**. It is **not** part of the public
 * API and should not be used or modified in production.
 * @returns The Revoker instance.
 * @throws {Error} If the configuration is invalid.
 * @throws {Error} If the gRPC server fails to start.
 */
export async function createRevoker(config: Config, grpcFunctions: gRPCFunctions = {}): Promise<Revoker> {
  const revoker = new Revoker(config, grpcFunctions);
  return await revoker._grpcInit();
}
