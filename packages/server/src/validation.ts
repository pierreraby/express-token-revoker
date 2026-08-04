import type { GenericLogger } from 'express-token-revoker';
import Joi from 'joi';

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

/** Authentication modes for the coordinator↔node gRPC link (PD-1). */
export type AuthMode = 'shared-secret' | 'mtls' | 'insecure';

/** Minimum shared-secret length (Joi-enforced on both sides). */
export const AUTH_SECRET_MIN_LENGTH = 16;

/**
 * Auth configuration for the coordinator's gRPC service (PD-1).
 *
 * - `shared-secret` (DEFAULT): one-way TLS + shared secret in gRPC
 *   metadata — the "API key over HTTPS" pattern. Requires `caCertPath`,
 *   `serverCertPath`, `serverKeyPath` and `secret` (>= 16 chars).
 * - `mtls`: mutual TLS (`checkClientCertificate=true`) on top of the
 *   shared-secret requirements.
 * - `insecure`: development ONLY — no TLS, no secret. Must be opted into
 *   explicitly; the server logs a loud warning at startup and refuses
 *   non-loopback binds.
 */
export interface CoordinatorAuthConfig {
  /** Auth mode. Defaults to 'shared-secret'. */
  mode?: AuthMode;
  /** Shared secret (required for shared-secret and mtls, min 16 chars). */
  secret?: string;
  /** PEM CA certificate (trust anchor). Required for shared-secret/mtls. */
  caCertPath?: string;
  /** PEM server certificate. Required for shared-secret/mtls. */
  serverCertPath?: string;
  /** PEM server private key. Required for shared-secret/mtls. */
  serverKeyPath?: string;
  /** Node-side only — ignored by the coordinator. */
  clientCertPath?: string;
  /** Node-side only — ignored by the coordinator. */
  clientKeyPath?: string;
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
   * gRPC auth (PD-1). Defaults to `{ mode: 'shared-secret' }` — which then
   * requires the TLS paths and the secret. `{ mode: 'insecure' }` is
   * development-only and must be explicit.
   */
  auth?: CoordinatorAuthConfig;
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

/**
 * Coordinator-side auth schema (PD-1). TLS modes require the CA, the
 * server keypair and a >= 16-char shared secret; `insecure` requires
 * nothing (it must merely be explicit).
 */
export const coordinatorAuthSchema = Joi.object({
  mode: Joi.string().valid('shared-secret', 'mtls', 'insecure').default('shared-secret'),
  // TLS modes (shared-secret, mtls) require the secret + every cert path;
  // only 'insecure' may omit them. `otherwise` avoids the thenable shape.
  secret: Joi.string().min(AUTH_SECRET_MIN_LENGTH).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  caCertPath: Joi.string().min(1).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  serverCertPath: Joi.string().min(1).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  serverKeyPath: Joi.string().min(1).when('mode', {
    is: 'insecure',
    otherwise: Joi.required(),
  }),
  clientCertPath: Joi.string().min(1).optional(),
  clientKeyPath: Joi.string().min(1).optional(),
});

export const coordinatorInputSchema = Joi.object({
  id: Joi.string().pattern(idPattern).required(),
  logger: loggerSchema.optional(),
  port: Joi.number().integer().min(0).max(65535).required(),
  host: Joi.string().min(1).optional(),
  auth: coordinatorAuthSchema.optional(),
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
