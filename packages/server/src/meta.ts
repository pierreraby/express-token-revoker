import fs from 'node:fs';
import path from 'node:path';
import { InternalError } from 'express-token-revoker';
import type { MetaState } from './types.js';

/**
 * Fresh coordinator state: no rotations, no events, no consistency point.
 */
export const EMPTY_META_STATE: MetaState = Object.freeze({
  generation: 0,
  lastLsn: 0,
  lastBackupLsn: 0,
});

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Atomic JSON persistence for the coordinator's meta state.
 *
 * Uses the same crash-safety pattern as core's blob writes: write to a temp
 * file, fsync, then rename over the target — a crash can never leave a torn
 * meta file.
 *
 * A corrupt meta file is a loud, unrecoverable error: silently resetting it
 * could resume LSN numbering below already-served events or lose the
 * generation count, both of which can break replication consistency. The
 * operator must decide (inspect, repair, or wipe the data dir knowingly).
 */
export class Meta {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /**
   * Reads the meta state.
   * @returns The persisted state, or zeros when the file does not exist yet.
   * @throws {InternalError} If the file exists but is unreadable, not valid
   * JSON, or has an invalid shape.
   */
  read(): MetaState {
    if (!fs.existsSync(this.#filePath)) {
      return { ...EMPTY_META_STATE };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.#filePath, 'utf8');
    } catch (error) {
      throw new InternalError(
        `Failed to read coordinator meta file ${this.#filePath}: ${(error as Error).message}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InternalError(
        `Corrupt coordinator meta file at ${this.#filePath} (invalid JSON): ${(error as Error).message}. ` +
          'Refusing to start — inspect the file and repair or wipe the data dir explicitly.'
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new InternalError(
        `Corrupt coordinator meta file at ${this.#filePath}: expected a JSON object.`
      );
    }

    const candidate = parsed as Partial<MetaState>;
    if (
      !isNonNegativeInteger(candidate.generation) ||
      !isNonNegativeInteger(candidate.lastLsn) ||
      !isNonNegativeInteger(candidate.lastBackupLsn)
    ) {
      throw new InternalError(
        `Corrupt coordinator meta file at ${this.#filePath}: generation/lastLsn/lastBackupLsn ` +
          'must be non-negative integers.'
      );
    }

    return {
      generation: candidate.generation,
      lastLsn: candidate.lastLsn,
      lastBackupLsn: candidate.lastBackupLsn,
    };
  }

  /**
   * Atomically persists the meta state (tmp + fsync + rename).
   * @throws {InternalError} If the write fails.
   */
  write(state: MetaState): void {
    const dir = path.dirname(this.#filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.#filePath}.tmp`;
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(state));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.#filePath);
    } catch (error) {
      throw new InternalError(
        `Failed to write coordinator meta file ${this.#filePath}: ${(error as Error).message}`
      );
    }
  }
}
