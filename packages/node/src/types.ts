import type { GenericLogger } from 'express-token-revoker';

/**
 * Shape of one StreamEvent as received on the wire (oneofs: true).
 * Mirrors the distributed.proto definition loaded with
 * `longs: String` — int64 LSNs arrive as strings.
 */
export interface WireStreamEvent {
  event?: 'entry' | 'rotate' | 'keepalive' | 'resnapshot';
  entry?: { lsn: string; generation: number; item: string };
  rotate?: { lsn: string; generation: number };
  keepalive?: Record<string, never>;
  resnapshot?: { generation: number };
}

/**
 * Bootstrap snapshot as returned by GetSnapshot (wire shape).
 * `lastBackupLsn` is an int64 string (`longs: String`).
 */
export interface SnapshotResponse {
  currentBlob: Buffer | Uint8Array;
  previousBlob: Buffer | Uint8Array;
  generation: number;
  lastBackupLsn: string | number;
  numItems: number;
  fpRate: number;
  k: number;
  rotateTime: number;
}

/**
 * Persisted node sync state (atomic JSON file, sync-state-<nodeId>.json).
 *
 * - `lastLsn`: highest replication LSN applied AND persisted.
 * - `generation`: coordinated generation after the last applied Rotate.
 * - `dirty`: the node self-rotated while degraded (coordinator unreachable
 *   beyond the safety timeout). A dirty node re-bootstraps from the
 *   coordinator snapshot on its next restart (init) instead of incremental
 *   catch-up.
 */
export interface SyncState {
  lastLsn: number;
  generation: number;
  dirty: boolean;
}

/** Minimal logger contract — core's GenericLogger re-exported. */
export type { GenericLogger };
