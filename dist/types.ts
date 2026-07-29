import type { Revoker } from './index.js';

/**
 * Any logger implementing the basic logging methods.
 */
export interface GenericLogger {
  /** Log an error message */
  error(...args: any[]): void;
  /** Log a warning message */
  warn(...args: any[]): void;
  /** Log an info message */
  info(...args: any[]): void;
  /** Log a debug message */
  debug(...args: any[]): void;
}

/**
 * Store managing the registered Revoker instances (used by gRPC).
 */
export interface RevokerStore {
  /** Initializes the Revoker instances map. */
  init(): void;
  /** Registers a revoker instance. */
  registerInstance(revokerInstance: Revoker): void;
  /** Unregisters a revoker instance. */
  unregisterInstance(revokerId: string): void;
  /** Finds a revoker instance by ID. */
  findInstance(
    revokerId: string,
    logger: GenericLogger
  ): (Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }) | undefined;
  /** Lists all registered revoker instances Id. */
  listInstances(): string[];
  /** Destroys the Revoker instances map. */
  destroy(): void;
  /** Store is empty */
  isEmpty(): boolean;
}
