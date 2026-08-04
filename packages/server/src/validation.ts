import Joi from 'joi';
import type { GenericLogger } from 'express-token-revoker';

/**
 * Identifier pattern shared with core: ids are interpolated into file names
 * (backup blobs, canonical WAL files) — this guards against path traversal.
 */
export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Bloom filter configuration for the coordinator's wrapped revoker.
 *
 * `backup` and `backupRatioTime` are REQUIRED: the canonical snapshot
 * served to bootstrapping nodes is built from core's blob files, and the
 * coordinator must produce them. Buffering is forbidden (bufferEnabled) —
 * canonical-first crash safety requires synchronous persistence end to end.
 */
export interface CoordinatorFilterConfig {
  /** Number of items to store in the Bloom filter. */
  numItems: number;
  /** Target false positive rate (exclusive (0,1)). */
  fpRate: number;
  /** Rotation interval in milliseconds — the coordinator owns the schedule. */
  rotateTime: number;
  /** Ratio of rotateTime for core's periodic backups (e.g. 4). */
  backupRatioTime: number;
}

interface CoordinatorConfigBase {
  /** Coordinator / revoker id (also used in canonical WAL file names). */
  id: string;
  /** Logger. Defaults to console. */
  logger?: GenericLogger;
  /** gRPC port to bind (0 = ephemeral, for tests). */
  port: number;
  /** Bind host. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /**
   * Allow binding without TLS on a non-loopback host.
   * PD-1 (auth/TLS) is still a pending product decision: v1 default posture
   * mirrors core — loopback only unless this explicit opt-in is set.
   */
  allowInsecure?: boolean;
  /** Interval between stream keepalives in ms. Defaults to 5000. */
  keepaliveIntervalMs?: number;
  /** Directory for core's blobs + WAL (the snapshot source). */
  backupDir: string;
  /**
   * Directory for the canonical WAL + meta file.
   * Defaults to `<backupDir>/canonical`.
   */
  walDir?: string;
  /** Bloom filter configuration. */
  filter: CoordinatorFilterConfig;
}

export type CoordinatorJWTConfig = CoordinatorConfigBase & {
  claimsToCheck: string[];
  payloadKey: string;
  opaqueHeader?: never;
};
export type CoordinatorOpaqueConfig = CoordinatorConfigBase & {
  opaqueHeader: string;
  claimsToCheck?: never;
  payloadKey?: never;
};
export type CoordinatorConfig = CoordinatorJWTConfig | CoordinatorOpaqueConfig;

const loggerSchema = Joi.object({
  error: Joi.function().required(),
  warn: Joi.function().required(),
  info: Joi.function().required(),
  debug: Joi.function().required(),
});

export const coordinatorFilterSchema = Joi.object({
  numItems: Joi.number().integer().min(1).max(100_000_000).required(),
  fpRate: Joi.number().positive().less(1).required(),
  rotateTime: Joi.number().integer().positive().required(),
  backupRatioTime: Joi.number().positive().required(),
});

export const coordinatorInputSchema = Joi.object({
  id: Joi.string().pattern(idPattern).required(),
  logger: loggerSchema.optional(),
  port: Joi.number().integer().min(0).max(65535).required(),
  host: Joi.string().min(1).optional(),
  allowInsecure: Joi.boolean().optional(),
  keepaliveIntervalMs: Joi.number().integer().min(100).optional(),
  backupDir: Joi.string().min(1).required(),
  walDir: Joi.string().min(1).optional(),
  claimsToCheck: Joi.array().items(Joi.string().min(1)).min(1).optional(),
  payloadKey: Joi.string().min(1).optional(),
  opaqueHeader: Joi.string().min(1).optional(),
  filter: coordinatorFilterSchema.required(),
})
  .xor('claimsToCheck', 'opaqueHeader')
  .with('claimsToCheck', ['payloadKey']);
