import { ValidationError } from 'express-token-revoker';
import { RevokerNode, type NodeDependencies } from './revokerNode.js';
import { nodeInputSchema, type RevokerNodeConfig } from './validation.js';

/**
 * Creates and starts a distributed revocation participant node.
 *
 * The node replicates revocation events from the coordinator over the
 * ordered gRPC stream, maintains its own local Bloom filters (core with
 * backup enabled) and serves the Express middleware from local state.
 *
 * Startup: clean local state (sync state + blobs) ⇒ local restore +
 * catch-up from the persisted LSN; otherwise snapshot bootstrap
 * (GetSnapshot → geometry check → install → Subscribe(lastBackupLsn)).
 *
 * @param config - Node configuration (validated with Joi).
 * @param deps - Test-only dependency injection hooks (see NodeDependencies).
 * @returns A started RevokerNode.
 * @throws {ValidationError} If the configuration is invalid or the
 * snapshot geometry does not match.
 * @throws {InternalError} If the node fails to start.
 */
export async function createRevokerNode(
  config: RevokerNodeConfig,
  deps: NodeDependencies = {}
): Promise<RevokerNode> {
  const { error, value } = nodeInputSchema.validate(config, {
    abortEarly: false,
    allowUnknown: false,
  });
  if (error) {
    throw new ValidationError(`Invalid node config: ${error.message}`);
  }
  const validated = value as RevokerNodeConfig;

  const node = new RevokerNode(validated, deps);
  try {
    await node.init();
  } catch (initError) {
    // Clean up whatever came up so a failed start never leaks intervals,
    // channels or file handles (core's grpc-bind lesson).
    try {
      await node.shutdown();
    } catch {
      // Best effort — the primary failure is reported below.
    }
    throw initError;
  }
  return node;
}

export { RevokerNode } from './revokerNode.js';
export type { CoordinatorClientLike, NodeDependencies, NodeHealthStatus, SyncHealthComponent } from './revokerNode.js';
export { CoordinatorClient } from './coordinatorClient.js';
export type { CoordinatorClientOptions, RawCoordinatorClient } from './coordinatorClient.js';
export { SyncEngine } from './syncEngine.js';
export type {
  SyncEngineClient,
  SyncEngineMode,
  SyncEngineOptions,
  SyncEngineRevoker,
  SyncStateStore,
  SyncSubscription,
} from './syncEngine.js';
export { StateFile } from './stateFile.js';
export { nodeInputSchema, nodeFilterSchema, idPattern } from './validation.js';
export type {
  NodeFilterConfig,
  RevokerNodeConfig,
  RevokerNodeJWTConfig,
  RevokerNodeOpaqueConfig,
} from './validation.js';
export type { GenericLogger, SnapshotResponse, SyncState, WireStreamEvent } from './types.js';
// Re-export core's error classes so consumers of the node package do not
// need a second import for catch blocks.
export { ValidationError, InternalError } from 'express-token-revoker';
