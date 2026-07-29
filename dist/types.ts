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
 * Result of a single health check component.
 */
export interface HealthCheckComponent {
  /** Whether this component is healthy. */
  healthy: boolean;
  /** Error message if unhealthy. */
  error?: string;
}

/**
 * Overall health status of the token revoker.
 */
export interface HealthStatus {
  /** True when all components are healthy. */
  healthy: boolean;
  /** Per-component health checks. */
  checks: {
    /** Storage (backup directory writable). */
    storage: HealthCheckComponent;
    /** Bloom filter (current filter initialized). */
    filter: HealthCheckComponent;
    /** Rotation (interval timer running). */
    rotation: HealthCheckComponent;
  };
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
