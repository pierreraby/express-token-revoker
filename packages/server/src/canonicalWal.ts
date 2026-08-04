import fs from 'node:fs';
import path from 'node:path';
import { InternalError } from 'express-token-revoker';
import type { GenericLogger, CanonicalEvent } from './types.js';

/**
 * Options for the canonical write-ahead log.
 */
export interface CanonicalWalOptions {
  /** Directory holding the per-generation canonical WAL files. */
  dir: string;
  /** Revoker id — interpolated into file names (validated upstream by Joi). */
  revokerId: string;
  /** Logger. */
  logger: GenericLogger;
}

/**
 * Result of scanning the canonical WAL files on disk.
 */
export interface CanonicalWalScan {
  /** Highest LSN found across all files (0 when no events exist). */
  maxLsn: number;
  /** Highest generation found across file names and rotation markers. */
  maxGeneration: number;
}

/**
 * The coordinator's canonical write-ahead log.
 *
 * One append-only file per filter generation: `canonical-<revokerId>-<generation>.wal`.
 * Every event carries a monotonic LSN; three line formats share a common
 * `<lsn>:<type>:` prefix:
 *
 * - entry:       `<lsn>:E:<len>:<item>`     (revocation accepted for replication)
 * - tombstone:   `<lsn>:T:<len>:<item>`     (local apply failed for this LSN;
 *                                            item kept so the event stays deliverable)
 * - rotation:    `<lsn>:R:<generation>`     (coordinated rotation marker)
 *
 * Items are length-prefixed so parsing is safe for items containing colons,
 * tabs or any character except line breaks (the coordinator validates items
 * with the same rules as core before appending: no `\r`, `\n` or `\0`).
 *
 * Writes use `appendFileSync` — the same crash-safety rationale as core's
 * WAL: canonical-first ordering means a revocation is durable BEFORE it is
 * applied to the in-memory filter, and nothing assigned an LSN can be lost
 * by a coordinator crash.
 */
export class CanonicalWal {
  readonly #dir: string;
  readonly #revokerId: string;
  readonly #logger: GenericLogger;
  /** Next LSN to assign (LSNs start at 1; 0 is the "no events" cursor). */
  #nextLsn = 0;
  /** Generation stamped on entries appended from now on. */
  #generation = 0;
  /**
   * Highest LSN known to have been deleted by retention. Any subscriber
   * resuming below this LSN cannot be served and must resnapshot. Set from
   * meta.lastBackupLsn at startup (retention never deletes entries above
   * the consistency point) and updated by truncateOldGenerations().
   */
  #deletedMaxLsn = 0;
  #initialized = false;

  constructor(options: CanonicalWalOptions) {
    this.#dir = options.dir;
    this.#revokerId = options.revokerId;
    this.#logger = options.logger;
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
    } catch (error) {
      throw new InternalError(
        `Failed to create canonical WAL dir ${this.#dir}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Prepares the log for appending.
   * @param nextLsn - LSN that will be assigned to the next event (highest
   * known LSN + 1, or 1 on a fresh cluster).
   * @param generation - Current filter generation.
   * @param deletedMaxLsn - Retention floor: highest LSN known to have been
   * truncated in the past (meta.lastBackupLsn at startup).
   */
  init(nextLsn: number, generation: number, deletedMaxLsn: number): void {
    this.#nextLsn = nextLsn;
    this.#generation = generation;
    this.#deletedMaxLsn = deletedMaxLsn;
    this.#initialized = true;
  }

  /** Highest assigned LSN (0 when nothing has been appended yet). */
  get lastLsn(): number {
    return this.#nextLsn - 1;
  }

  /** Generation stamped on entries appended now. */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Whether a subscriber that last applied `fromLsn` can be served from the
   * retained files. False ⇒ the node must resnapshot.
   */
  canServeFrom(fromLsn: number): boolean {
    return fromLsn >= this.#deletedMaxLsn;
  }

  /** File name of the WAL file for a generation. */
  #fileName(generation: number): string {
    return `canonical-${this.#revokerId}-${generation}.wal`;
  }

  #filePath(generation: number): string {
    return path.join(this.#dir, this.#fileName(generation));
  }

  /**
   * Lists existing (generation, filePath) pairs sorted by generation
   * ascending. Non-matching files in the directory are ignored.
   */
  #listGenerationFiles(): Array<{ generation: number; filePath: string }> {
    const prefix = `canonical-${this.#revokerId}-`;
    const suffix = '.wal';
    let names: string[];
    try {
      names = fs.readdirSync(this.#dir);
    } catch {
      return [];
    }
    const found: Array<{ generation: number; filePath: string }> = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
        continue;
      }
      const generationPart = name.slice(prefix.length, name.length - suffix.length);
      if (!/^\d+$/.test(generationPart)) {
        continue;
      }
      found.push({
        generation: Number.parseInt(generationPart, 10),
        filePath: path.join(this.#dir, name),
      });
    }
    found.sort((a, b) => a.generation - b.generation);
    return found;
  }

  /**
   * Parses one WAL line. Returns null for malformed lines (caller decides
   * how loud to be).
   */
  #parseLine(line: string): CanonicalEvent | null {
    // <lsn>:<E|T|R>:<rest> — lsn is digits, type one char: split on the
    // first two colons only; the remainder may contain colons.
    const first = line.indexOf(':');
    if (first <= 0) {
      return null;
    }
    const second = line.indexOf(':', first + 1);
    if (second < 0) {
      return null;
    }
    const lsn = Number(line.slice(0, first));
    const type = line.slice(first + 1, second);
    if (!Number.isInteger(lsn) || lsn <= 0) {
      return null;
    }

    if (type === 'R') {
      const generation = Number(line.slice(second + 1));
      if (!Number.isInteger(generation) || generation < 0) {
        return null;
      }
      return { type: 'rotate', lsn, generation };
    }

    if (type === 'E' || type === 'T') {
      // <len>:<item> — item is exactly `len` characters (may contain colons).
      const lenColon = line.indexOf(':', second + 1);
      if (lenColon < 0) {
        return null;
      }
      const len = Number(line.slice(second + 1, lenColon));
      const item = line.slice(lenColon + 1);
      if (!Number.isInteger(len) || len < 0 || item.length !== len) {
        return null;
      }
      return type === 'E'
        ? { type: 'entry', lsn, generation: this.#generationOfFile ?? 0, item }
        : { type: 'tombstone', lsn, generation: this.#generationOfFile ?? 0, item };
    }

    return null;
  }

  /**
   * Generation of the file currently being parsed — entries inherit the
   * generation of their file unless a later rotation marker in the same file
   * updates it (entries are always appended to the current-generation file).
   */
  #generationOfFile: number | null = null;

  /**
   * Parses a whole file. Malformed lines are logged at error level and
   * skipped — a torn trailing line can happen after a crash mid-append;
   * losing loudness here would hide canonical data loss.
   */
  #parseFile(filePath: string, generationOfName: number): CanonicalEvent[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new InternalError(
        `Failed to read canonical WAL file ${filePath}: ${(error as Error).message}`
      );
    }
    const events: CanonicalEvent[] = [];
    this.#generationOfFile = generationOfName;
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      const event = this.#parseLine(line);
      if (!event) {
        this.#logger.error(
          `Skipping malformed canonical WAL line in ${path.basename(filePath)} ` +
            `(length ${line.length}) — possible torn write. Inspect the file.`
        );
        continue;
      }
      if (event.type === 'rotate') {
        this.#generationOfFile = event.generation;
      }
      events.push(event);
    }
    return events;
  }

  #requireInitialized(): void {
    if (!this.#initialized) {
      throw new InternalError('CanonicalWal is not initialized — call init() first');
    }
  }

  #appendLine(line: string): void {
    this.#requireInitialized();
    const filePath = this.#filePath(this.#generation);
    try {
      fs.appendFileSync(filePath, `${line}\n`);
    } catch (error) {
      throw new InternalError(
        `Failed to append to canonical WAL ${filePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Appends a revocation entry and assigns its LSN.
   * Canonical-first: call this BEFORE applying the item to the filter.
   * @returns The assigned LSN.
   */
  appendEntry(item: string): number {
    const lsn = this.#nextLsn;
    this.#nextLsn += 1;
    this.#appendLine(`${lsn}:E:${item.length}:${item}`);
    return lsn;
  }

  /**
   * Marks an LSN whose local apply failed (e.g. saturation).
   *
   * The tombstone keeps the item so the event remains deliverable: nodes
   * still receive (and apply) the entry — over-revocation is the safe
   * direction — while the tombstone records that the coordinator's own
   * filter legitimately lacks it. Startup replay skips tombstoned entries so
   * the coordinator converges to its true state.
   */
  appendTombstone(lsn: number, item: string): void {
    this.#appendLine(`${lsn}:T:${item.length}:${item}`);
  }

  /**
   * Appends a coordinated rotation marker, assigns its LSN, and switches the
   * current generation for subsequent entries.
   * @returns The assigned LSN.
   */
  appendRotate(generation: number): number {
    const lsn = this.#nextLsn;
    this.#nextLsn += 1;
    this.#appendLine(`${lsn}:R:${generation}`);
    this.#generation = generation;
    return lsn;
  }

  /**
   * Reads all retained events with `lsn > fromLsn`, deduplicated by LSN
   * (a tombstone overrides the entry at the same LSN), ordered by LSN,
   * capped at `maxEvents`.
   */
  readSince(fromLsn: number, maxEvents: number): CanonicalEvent[] {
    this.#requireInitialized();
    const byLsn = new Map<number, CanonicalEvent>();
    for (const file of this.#listGenerationFiles()) {
      const events = this.#parseFile(file.filePath, file.generation);
      for (const event of events) {
        if (event.lsn > fromLsn) {
          // Files are scanned in generation order and lines in append order,
          // so a later insert correctly overrides (tombstone wins at its LSN).
          byLsn.set(event.lsn, event);
        }
      }
    }
    const sorted = Array.from(byLsn.values()).sort((a, b) => a.lsn - b.lsn);
    if (maxEvents > 0 && sorted.length > maxEvents) {
      return sorted.slice(0, maxEvents);
    }
    return sorted;
  }

  /**
   * Scans all retained files without the fromLsn filter (startup discovery).
   */
  scan(): CanonicalWalScan {
    let maxLsn = 0;
    let maxGeneration = 0;
    for (const file of this.#listGenerationFiles()) {
      if (file.generation > maxGeneration) {
        maxGeneration = file.generation;
      }
      const events = this.#parseFile(file.filePath, file.generation);
      for (const event of events) {
        if (event.lsn > maxLsn) {
          maxLsn = event.lsn;
        }
        if (event.type === 'rotate' && event.generation > maxGeneration) {
          maxGeneration = event.generation;
        }
      }
    }
    return { maxLsn, maxGeneration };
  }

  /**
   * Retention: deletes WAL files for generations below `keepFromGeneration`,
   * but NEVER a file that still holds events with `lsn > lsnFloor` — the
   * caller passes the snapshot consistency point (lastBackupLsn) as the
   * floor so the canonical tail served to bootstrapping nodes stays intact.
   *
   * @returns The names of the deleted files.
   */
  truncateOldGenerations(keepFromGeneration: number, lsnFloor: number): string[] {
    this.#requireInitialized();
    const deleted: string[] = [];
    for (const file of this.#listGenerationFiles()) {
      if (file.generation >= keepFromGeneration) {
        continue;
      }
      const events = this.#parseFile(file.filePath, file.generation);
      let fileMaxLsn = 0;
      for (const event of events) {
        if (event.lsn > fileMaxLsn) {
          fileMaxLsn = event.lsn;
        }
      }
      if (fileMaxLsn > lsnFloor) {
        // Entries above the consistency point are still needed for
        // tail-replay — keep the file even though its generation is old.
        this.#logger.warn(
          `Keeping canonical WAL ${path.basename(file.filePath)} despite generation retention: ` +
            `it holds events above the backup floor (lsn ${fileMaxLsn} > ${lsnFloor}).`
        );
        continue;
      }
      try {
        fs.unlinkSync(file.filePath);
        deleted.push(path.basename(file.filePath));
        if (fileMaxLsn > this.#deletedMaxLsn) {
          this.#deletedMaxLsn = fileMaxLsn;
        }
      } catch (error) {
        this.#logger.error(
          `Failed to delete canonical WAL ${file.filePath}: ${(error as Error).message}`
        );
      }
    }
    return deleted;
  }
}
