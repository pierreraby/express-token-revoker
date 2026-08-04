import Joi from 'joi';
import type { GenericLogger } from 'express-token-revoker';

/**
 * Identifier pattern shared with core: nodeId is interpolated into file
 * names (backup blobs, WAL, sync-state) — this guards against path
 * traversal.
 */
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Bloom filter configuration for the node's wrapped revoker.
 *
 * `rotateTime` is the EXPECTED COORDINATOR rotateTime: the node derives its
 * own core rotateTime as `rotateTime × safetyFactor` (the degraded
 * self-rotation safety timeout — see docs/distributed-architecture.md).
 */
export interface NodeFilterConfig {
  /** Number of items to store in the Bloom filter (must match coordinator). */
  numItems: number;
  /** Target false positive rate (exclusive (0,1), must match coordinator). */
  fpRate: number;
  /** Expected coordinator rotateTime in milliseconds. */
  rotateTime: number;
  /** Ratio of the node rotateTime for core's periodic backups. Defaults to 2. */
  backupRatioTime?: number;
}

interface NodeConfigBase {
  /** This node's id (validated like core ids — used in file names). */
  nodeId: string;
  /** Coordinator address (`host:port`). */
  coordinatorAddress: string;
  /** Logger. Defaults to console. */
  logger?: GenericLogger;
  /** Directory for the node's blobs, WAL and sync-state file. */
  backupDir: string;
  /** Degraded-mode PollDeltas cadence in ms. Defaults to 2000. */
  pollIntervalMs?: number;
  /**
   * Degraded self-rotation safety factor (>= 2): the node's core
   * rotateTime = coordinator rotateTime × safetyFactor. Defaults to 2.5.
   */
  safetyFactor?: number;
  /**
   * PD-1 placeholder: static metadata attached to every coordinator call
   * (e.g. shared-secret header). NOT real transport security — v1 assumes
   * a trusted/loopback network until the auth decision lands.
   */
  authMetadata?: Record<string, string>;
  /** Bloom filter configuration. */
  filter: NodeFilterConfig;
}

export type RevokerNodeJWTConfig = NodeConfigBase & {
  claimsToCheck: string[];
  payloadKey: string;
  opaqueHeader?: never;
};
export type RevokerNodeOpaqueConfig = NodeConfigBase & {
  opaqueHeader: string;
  claimsToCheck?: never;
  payloadKey?: never;
};
export type RevokerNodeConfig = RevokerNodeJWTConfig | RevokerNodeOpaqueConfig;

const loggerSchema = Joi.object({
  error: Joi.function().required(),
  warn: Joi.function().required(),
  info: Joi.function().required(),
  debug: Joi.function().required(),
});

export const nodeFilterSchema = Joi.object({
  numItems: Joi.number().integer().min(1).max(100_000_000).required(),
  fpRate: Joi.number().positive().less(1).required(),
  rotateTime: Joi.number().integer().positive().required(),
  backupRatioTime: Joi.number().positive().optional(),
});

export const nodeInputSchema = Joi.object({
  nodeId: Joi.string().pattern(idPattern).required(),
  coordinatorAddress: Joi.string().min(3).required(),
  logger: loggerSchema.optional(),
  backupDir: Joi.string().min(1).required(),
  pollIntervalMs: Joi.number().integer().min(100).optional(),
  safetyFactor: Joi.number().min(2).optional(),
  authMetadata: Joi.object().pattern(Joi.string(), Joi.string()).optional(),
  claimsToCheck: Joi.array().items(Joi.string().min(1)).min(1).optional(),
  payloadKey: Joi.string().min(1).optional(),
  opaqueHeader: Joi.string().min(1).optional(),
  filter: nodeFilterSchema.required(),
})
  .xor('claimsToCheck', 'opaqueHeader')
  .with('claimsToCheck', ['payloadKey']);
