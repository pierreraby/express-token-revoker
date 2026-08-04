import type { GenericLogger } from 'express-token-revoker';
import Joi from 'joi';

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

/** Authentication modes for the coordinator↔node gRPC link (PD-1). */
export type AuthMode = 'shared-secret' | 'mtls' | 'insecure';

/** Minimum shared-secret length (Joi-enforced on both sides). */
export const AUTH_SECRET_MIN_LENGTH = 16;

/**
 * Auth configuration for the node's coordinator client (PD-1). Mirrors the
 * coordinator-side schema:
 *
 * - `shared-secret` (DEFAULT): one-way TLS + shared secret in gRPC
 *   metadata. Requires `caCertPath` and `secret` (>= 16 chars).
 * - `mtls`: adds the client certificate requirement (`clientCertPath` +
 *   `clientKeyPath`) on top of the shared-secret requirements.
 * - `insecure`: development ONLY — no TLS, no secret. Must be opted into
 *   explicitly; the client logs a loud warning at startup.
 */
export interface NodeAuthConfig {
  /** Auth mode. Defaults to 'shared-secret'. */
  mode?: AuthMode;
  /** Shared secret (required for shared-secret and mtls, min 16 chars). */
  secret?: string;
  /** PEM CA certificate (trust anchor for the coordinator). Required for shared-secret/mtls. */
  caCertPath?: string;
  /** Coordinator-side only — ignored by the node. */
  serverCertPath?: string;
  /** Coordinator-side only — ignored by the node. */
  serverKeyPath?: string;
  /** PEM client certificate. Required for mtls. */
  clientCertPath?: string;
  /** PEM client private key. Required for mtls. */
  clientKeyPath?: string;
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
   * Expected coordinator keepalive interval in ms — must mirror the
   * coordinator's `keepaliveIntervalMs`. The sync engine force-reconnects
   * a stream that stays silent for 3 intervals (stalled-stream detection).
   * Defaults to 5000.
   */
  keepaliveIntervalMs?: number;
  /**
   * Degraded self-rotation safety factor (>= 2): the node's core
   * rotateTime = coordinator rotateTime × safetyFactor. Defaults to 2.5.
   */
  safetyFactor?: number;
  /**
   * gRPC auth (PD-1). Defaults to `{ mode: 'shared-secret' }` — which then
   * requires the CA path and the secret. `{ mode: 'insecure' }` is
   * development-only and must be explicit.
   */
  auth?: NodeAuthConfig;
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

/**
 * Node-side auth schema (PD-1). TLS modes require the CA + a >= 16-char
 * shared secret; mtls additionally requires the client keypair; `insecure`
 * requires nothing (it must merely be explicit).
 */
export const nodeAuthSchema = Joi.object({
  mode: Joi.string().valid('shared-secret', 'mtls', 'insecure').default('shared-secret'),
  secret: Joi.string().min(AUTH_SECRET_MIN_LENGTH).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  caCertPath: Joi.string().min(1).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  serverCertPath: Joi.string().min(1).optional(),
  serverKeyPath: Joi.string().min(1).optional(),
  clientCertPath: Joi.string()
    .min(1)
    .when('mode', {
      is: Joi.string().not('mtls'),
      otherwise: Joi.required(),
    }),
  clientKeyPath: Joi.string()
    .min(1)
    .when('mode', {
      is: Joi.string().not('mtls'),
      otherwise: Joi.required(),
    }),
});

export const nodeInputSchema = Joi.object({
  nodeId: Joi.string().pattern(idPattern).required(),
  coordinatorAddress: Joi.string().min(3).required(),
  logger: loggerSchema.optional(),
  backupDir: Joi.string().min(1).required(),
  pollIntervalMs: Joi.number().integer().min(100).optional(),
  keepaliveIntervalMs: Joi.number().integer().min(100).optional(),
  safetyFactor: Joi.number().min(2).optional(),
  auth: nodeAuthSchema.optional(),
  claimsToCheck: Joi.array().items(Joi.string().min(1)).min(1).optional(),
  payloadKey: Joi.string().min(1).optional(),
  opaqueHeader: Joi.string().min(1).optional(),
  filter: nodeFilterSchema.required(),
})
  .xor('claimsToCheck', 'opaqueHeader')
  .with('claimsToCheck', ['payloadKey']);
