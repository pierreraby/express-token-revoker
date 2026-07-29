import { BloomFilterManager } from './Bloom-filter-manager.js';
import { createJWTMiddleware, createOpaqueMiddleware } from './createMiddlewares.js';
import { ValidationError, InternalError } from './errors.js';
import throttle from 'throttleit';
import { stopServer, startServer } from './grpc/std-server.js';
import { revokerInputSchema } from './Inputs-validation.js';
import RevokerStore from './revokerStore.js';
import type { GenericLogger, HealthStatus, RevokerStore as RevokerStoreType } from './types.js';
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
  /** The absolute path to the backup directory. Defaults to a 'backup' directory relative to the current working directory. */
  backupDir?: string;
  /** Whether to enable buffering of items to add to the Bloom filter. Defaults to false. */
  bufferEnabled?: boolean;
  /** Maximum number of tokens to hold in the write buffer before rejecting new additions. Defaults to numItems * 2. */
  bufferMaxSize?: number;
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
  /**
   * Host to bind the gRPC server to. Defaults to `127.0.0.1` (loopback only).
   * The gRPC admin service is unauthenticated: do not bind it to a public
   * interface without TLS in front.
   */
  grpcHost?: string;
  /**
   * Allow binding the gRPC admin service without TLS on a non-loopback host.
   * Strongly discouraged — only for isolated/trusted networks.
   */
  grpcAllowInsecureRemote?: boolean;
  /** Configuration options for the Bloom filter. */
  filter: FilterConfig;
}

export type JWTConfig = ConfigBase & {
  claimsToCheck: string[];
  payloadKey: string;
  opaqueHeader?: never;
};
export type OpaqueConfig = ConfigBase & {
  opaqueHeader: string;
  claimsToCheck?: never;
  payloadKey?: never;
};
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
 * Shared promise guarding concurrent gRPC server initialization.
 * The first `createRevoker({ grpcEnabled: true })` call starts the server;
 * concurrent callers await the same initialization instead of racing
 * `revokerStore.init()` (which would throw "already initialized").
 * Reset to null when the server is stopped or when initialization fails.
 */
let grpcServerInitPromise: Promise<void> | null = null;

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
  grpcHost: string;
  grpcAllowInsecureRemote: boolean;
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
    { startServerFn = startServer, stopServerFn = stopServer }: gRPCFunctions = {},
    revokerStore: RevokerStoreType = RevokerStore
  ) {
    const { error } = revokerInputSchema.validate(config);
    if (error) {
      throw new ValidationError(`Invalid input: ${error.message}`);
    }

    const {
      id,
      claimsToCheck,
      payloadKey,
      opaqueHeader,
      grpcEnabled = false,
      grpcPort,
      grpcHost = '127.0.0.1',
      grpcAllowInsecureRemote = false,
      logger = console,
      filter,
    } = config;

    try {
      this.bloomFilterManager = new BloomFilterManager({ id, logger, ...filter });
    } catch (error) {
      throw new InternalError(
        `Failed to initialize BloomFilterManager: ${(error as Error).message}`
      );
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
        throttleLog
      );
    } else {
      this.bloomFilterManager.destroy();
      throw new ValidationError('claimsToCheck or opaqueHeader must be provided');
    }

    this.grpcEnabled = grpcEnabled;
    this.grpcPort = grpcPort ? Number(grpcPort) : 0;
    this.grpcHost = grpcHost;
    this.grpcAllowInsecureRemote = grpcAllowInsecureRemote;

    this.startServer = startServerFn;
    this.stopServer = stopServerFn;
    this.revokerStore = revokerStore;
  }

  /**
   * Initializes the grpc server.
   *
   * The server is a process-wide singleton: the first gRPC-enabled revoker
   * starts it, and concurrent `createRevoker` calls share the same
   * initialization promise instead of racing `revokerStore.init()`.
   *
   * @returns The Revoker instance.
   * @throws {Error} If the gRPC server fails to start.
   */
  async _grpcInit(): Promise<Revoker> {
    if (this.grpcEnabled && this.grpcPort) {
      if (Revoker.grpcServerStarted) {
        this.logger.info('gRPC server is already started.');
        this.revokerStore.registerInstance(this);
        return this;
      }

      this.logger.info(`Starting gRPC server with id: ${this.id}`);
      try {
        if (!grpcServerInitPromise) {
          grpcServerInitPromise = (async () => {
            this.revokerStore.init();
            // Pass the (possibly injected) store — not the imported singleton —
            // so gRPC handlers see the same instances as this revoker.
            await this.startServer(this.grpcPort, this.revokerStore, this.logger, {
              host: this.grpcHost,
              allowInsecureRemote: this.grpcAllowInsecureRemote,
            });
            Revoker.grpcServerStarted = true;
          })();
          // Allow a later createRevoker() to retry after a failed bind.
          grpcServerInitPromise.catch(() => {
            grpcServerInitPromise = null;
          });
        }
        await grpcServerInitPromise;
        this.revokerStore.registerInstance(this);
      } catch (error) {
        // The store was initialized but the server never started (e.g. port in
        // use): clean it up so the next createRevoker() can start fresh instead
        // of failing forever with "already initialized".
        if (!Revoker.grpcServerStarted) {
          try {
            if (this.revokerStore.isEmpty()) {
              this.revokerStore.destroy();
            }
          } catch {
            // Store was never initialized — nothing to clean up.
          }
        }
        await this.destroy(); // Cleanup
        const message = (error as Error).message;
        this.logger.error(`Failed to start gRPC server: ${message}`);
        throw new Error(`Failed to start gRPC server: ${message}`);
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
      throw new Error('Middleware not configured');
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
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
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
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
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
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
    }

    return this.bloomFilterManager.getMetrics();
  }

  /**
   * Checks the health of the Bloom filter system.
   *
   * @returns A structured health status object.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  healthCheck(): HealthStatus {
    if (this.grpcEnabled) {
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
    }

    return this.bloomFilterManager.healthCheck();
  }

  /**
   * Resets and restore the Bloom filter.
   * @throws {Error} If an error occurs during the reset or restoration.
   */
  async resetAndRestore(): Promise<void> {
    if (this.grpcEnabled) {
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
    }

    try {
      await this.bloomFilterManager.resetAndRestore();
      this.logger.info('Bloom filter has been reset and restored successfully.');
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
      throw new Error('gRPC is enabled, use the gRPC method instead');
    }

    if (!this.bloomFilterManager) {
      throw new Error('Bloom filter manager not initialized');
    }

    try {
      await this.bloomFilterManager.resetAndClearData();
      this.logger.info('Bloom filter has been reset and data cleared successfully.');
    } catch (error) {
      this.logger.error('Error in revoker.resetAndClearData:', error);
      throw error;
    }
  }

  /**
   * Unregisters this instance from the gRPC store and stops the gRPC server
   * when the last instance leaves. Shared by `shutdown()` and `destroy()`.
   */
  async #cleanupGrpc(): Promise<void> {
    if (this.grpcEnabled && Revoker.grpcServerStarted) {
      this.revokerStore.unregisterInstance(this.id);
      this.logger.info(`unregistering instance : ${this.id}`);
      this.grpcEnabled = false;
      if (this.revokerStore.isEmpty()) {
        this.logger.info('Stopping gRPC server');
        this.revokerStore.destroy();
        await this.stopServer(this.logger);
        Revoker.grpcServerStarted = false;
        grpcServerInitPromise = null;
      }
    }
  }

  /**
   * Gracefully shuts down the revoker.
   *
   * Rejects new add() calls, waits for in-progress operations, flushes the
   * write buffer if enabled, destroys all resources, and unregisters the
   * instance from the gRPC store (stopping the server if it was the last one).
   * Safe to call from a SIGTERM/SIGINT handler.
   */
  async shutdown(): Promise<void> {
    if (this.bloomFilterManager) {
      await this.bloomFilterManager.shutdown();
      this.middleware = null;
      this.bloomFilterManager = null;
    } else {
      this.logger.warn('Bloom filter manager already destroyed, nothing to shut down.');
    }
    await this.#cleanupGrpc();
  }

  /**
   * Destroys the Bloom filter manager.
   */
  async destroy(): Promise<void> {
    try {
      await this.#cleanupGrpc();
      if (this.bloomFilterManager) {
        this.bloomFilterManager.destroy();
        this.middleware = null;
        this.bloomFilterManager = null;
      } else {
        this.logger.warn('Bloom filter manager already destroyed');
      }
    } catch (error) {
      this.logger.error('Error during Revoker destruction:', error);
      throw new InternalError(`Failed to destroy Revoker: ${(error as Error).message}`);
    }
  }
}

/**
 * Creates a Revoker instance — the main public entry point.
 *
 * @param config - Configuration options.
 * @param grpcFunctions - Optional dependency injection for gRPC server management (mostly for tests).
 * @returns The Revoker instance.
 * @throws {ValidationError} If the configuration is invalid.
 * @throws {Error} If the gRPC server fails to start.
 */
export async function createRevoker(
  config: Config,
  grpcFunctions: gRPCFunctions = {}
): Promise<Revoker> {
  const revoker = new Revoker(config, grpcFunctions);
  return revoker._grpcInit();
}

// Public types and errors, so consumers can name return types and catch typed
// errors without deep imports.
export type {
  GenericLogger,
  HealthCheckComponent,
  HealthStatus,
  RevokerStore as RevokerStoreType,
} from './types.js';
export type {
  BloomFilterOptions,
  Configuration,
  EstimatedMetrics,
  Metrics,
} from './Bloom-filter-manager.js';
export type { JWTPayload } from './createMiddlewares.js';
export { ValidationError, InternalError } from './errors.js';
