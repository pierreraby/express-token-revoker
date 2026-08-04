import fs from 'node:fs';
import path from 'node:path';
import type { SyncState } from './types.js';

/**
 * Atomic persistence of the node's replication sync state.
 *
 * File: `sync-state-<nodeId>.json` in the node's backup directory, written
 * with the same tmp + fsync + rename pattern core uses for blob files — a
 * crash can never leave a torn state file.
 *
 * **Ordering contract (crash safety):** callers must persist the new state
 * only AFTER the corresponding event has been fully applied (entry in the
 * local WAL + in-memory filter, or rotation completed). Persisting first
 * would record an LSN whose event was never applied: after a crash the
 * node would resume past it — a silently dropped delta (global false
 * negative). The reverse (apply first, crash before persist) is safe:
 * at-least-once redelivery plus bloom idempotence makes re-application
 * harmless.
 *
 * A missing or corrupt file is treated as ABSENT (returns null) — the node
 * then re-bootstraps from the coordinator snapshot. Never guess state.
 */
export class StateFile {
  readonly #filePath: string;

  constructor(dir: string, nodeId: string) {
    this.#filePath = path.join(dir, `sync-state-${nodeId}.json`);
  }

  /** Absolute path of the state file (tests / diagnostics). */
  get filePath(): string {
    return this.#filePath;
  }

  /**
   * Reads the persisted state.
   * @returns The state, or null when the file is missing, unreadable,
   * corrupt or fails validation (all mean: rebootstrap).
   */
  read(): SyncState | null {
    try {
      if (!fs.existsSync(this.#filePath)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')) as Record<string, unknown>;
      if (
        typeof raw.lastLsn !== 'number' ||
        !Number.isInteger(raw.lastLsn) ||
        raw.lastLsn < 0 ||
        typeof raw.generation !== 'number' ||
        !Number.isInteger(raw.generation) ||
        raw.generation < 0
      ) {
        return null;
      }
      return {
        lastLsn: raw.lastLsn,
        generation: raw.generation,
        dirty: raw.dirty === true,
      };
    } catch {
      // Corrupt / unreadable ⇒ treated as absent ⇒ rebootstrap.
      return null;
    }
  }

  /**
   * Atomically writes the full state (tmp + fsync + rename).
   */
  write(state: SyncState): void {
    const tmpPath = `${this.#filePath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.#filePath);
  }

  /**
   * Merges a partial update into the persisted state (read-modify-write).
   * Used by the sync engine (lastLsn/generation — always together) and by
   * the node for the dirty flag.
   */
  update(partial: Partial<SyncState>): void {
    const current = this.read() ?? { lastLsn: 0, generation: 0, dirty: false };
    this.write({ ...current, ...partial });
  }

  /** Removes the state file (used when wiping local state). */
  delete(): void {
    fs.rmSync(this.#filePath, { force: true });
  }
}
