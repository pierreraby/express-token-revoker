import type { GenericLogger } from 'express-token-revoker';

/**
 * One event of the coordinator's canonical log.
 *
 * Events are totally ordered by LSN (Log Sequence Number). Three kinds are
 * persisted:
 * - `entry`: a revocation accepted for replication (item carried),
 * - `rotate`: a coordinated rotation marker (the generation becomes current),
 * - `tombstone`: the coordinator's local apply failed for this LSN (e.g.
 *   saturation). The item is still carried so the event can be delivered:
 *   the entry is replicated to nodes anyway — over-revocation is the safe
 *   direction (never a false negative) — while the coordinator's own filter
 *   legitimately lacks it. See `CanonicalWal.appendTombstone`.
 */
export type CanonicalEvent =
  | { type: 'entry'; lsn: number; generation: number; item: string }
  | { type: 'rotate'; lsn: number; generation: number }
  | { type: 'tombstone'; lsn: number; generation: number; item: string };

/**
 * Persisted coordinator state (atomic JSON meta file).
 *
 * - `generation`: number of coordinated rotations performed so far
 *   (monotonic across restarts — the coordinator's own generation, not the
 *   per-process generation maintained inside core).
 * - `lastLsn`: highest LSN durably recorded at the last meta checkpoint
 *   (rotations/truncation). The canonical WAL itself is the source of truth
 *   for LSN resumption — on restart the effective next LSN is derived from
 *   `max(lastLsn, highest LSN found in the WAL files) + 1`.
 * - `lastBackupLsn`: consistency point of the last coordinated rotation:
 *   every canonical entry with `lsn <= lastBackupLsn` is reflected in the
 *   core blob files. Nodes bootstrap with snapshot + `Subscribe(lastBackupLsn)`.
 */
export interface MetaState {
  generation: number;
  lastLsn: number;
  lastBackupLsn: number;
}

/**
 * Outbound replication event handed to node connections for ordered delivery.
 * `entry` covers both live entries and tombstoned entries (both are
 * delivered — see CanonicalEvent). Keepalives and resnapshot requests are
 * control events produced by the server itself.
 */
export type OutboundEvent =
  | { kind: 'entry'; lsn: number; generation: number; item: string }
  | { kind: 'rotate'; lsn: number; generation: number }
  | {
      kind: 'keepalive';
      /** Coordinator's current lastLsn (lag hint for receivers). */
      coordinatorLastLsn: number;
      /** Coordinator's current generation (lag hint for receivers). */
      generation: number;
    }
  | { kind: 'resnapshot'; generation: number };

/**
 * Minimal logger contract — mirrors core's GenericLogger (re-exported here
 * so server code does not multiply import sources).
 */
export type { GenericLogger };
