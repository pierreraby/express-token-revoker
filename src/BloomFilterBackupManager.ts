import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InternalError, ValidationError } from './errors.js';
import { Mutex } from 'async-mutex';
import { BloomFilterFactory } from './BloomFilterFactory.js';
import type { BloomFilter } from './bloomfilter.js';
import type { GenericLogger, HealthCheckComponent } from './types.js';
import type { BloomFilterOptions } from './Bloom-filter-manager.js';

export interface FilterParams {
  /** Number of items to store in the filter */
  numItems: number;
  /** False positive rate */
  fpRate: number;
  /** Number of hash functions */
  k: number;
}

type FilterName = 'current' | 'previous';

export interface RestoredFilters {
  current: BloomFilter | null;
  previous: BloomFilter | null;
}

/**
 * Manages backup and restoration of Bloom filters.
 */
export class BloomFilterBackupManager {
  id: string;
  backupInterval: NodeJS.Timeout | null = null;
  backupRatioTime: number;
  rotateTime: number;
  logger: GenericLogger;
  filterParams: FilterParams;
  backupDir: string;
  backupCurrentPath: string;
  backupPreviousPath: string;
  backupTempFilePath: string;
  bufferEnabled: boolean;
  writeBuffer: string[];
  /** Maximum number of tokens to hold in the write buffer before rejecting new additions. */
  maxBufferSize: number;
  writeInterval: NodeJS.Timeout | null;
  bufferFlushInterval: number;
  mutex: Mutex;
  /**
   * Generation counter incremented on every rotation. Periodic backups
   * capture the generation at schedule time and skip their write when the
   * filter has rotated since — a stale retry can no longer overwrite
   * post-rotation state and truncate the WAL.
   */
  #generation = 0;

  /**
   * Creates a new BloomFilterBackupManager instance
   * @param options - The options to configure the backup manager.
   * @param filterParams - The parameters to configure the Bloom filter.
   * @param logger - The logger instance.
   */
  constructor(options: BloomFilterOptions, filterParams: FilterParams, logger: GenericLogger) {
    this.id = options.id;
    this.backupRatioTime = options.backupRatioTime ?? 0;
    this.rotateTime = options.rotateTime;
    this.backupInterval = null;
    // this.remainingbackup = this.backupRatioTime ? this.backupRatioTime - 1 : 0; //number of backup remaining before rotation
    this.logger = logger;
    this.filterParams = filterParams;

    this.backupDir = options.backupDir || path.resolve(process.cwd(), 'backup');
    this.backupCurrentPath = path.join(this.backupDir, `current-${this.id}.blob`);
    this.backupPreviousPath = path.join(this.backupDir, `previous-${this.id}.blob`);
    this.backupTempFilePath = path.join(this.backupDir, `temp-${this.id}.txt`);

    this.mutex = new Mutex();

    this.bufferEnabled = options.bufferEnabled ?? false;
    this.writeBuffer = [];
    this.maxBufferSize = options.bufferMaxSize ?? Math.max(filterParams.numItems * 2, 100);
    this.writeInterval = null;
    this.bufferFlushInterval = 1000;

    this.#init();
  }

  /**
   * Ensures that the backup directory exists.
   * @throws {InternalError} If an error occurs while creating the backup directory.
   */
  #init(): void {
    this.#ensureBackupDirExists();
    if (this.bufferEnabled) {
      this.writeInterval = setInterval(() => this.#flushWriteBuffer(), this.bufferFlushInterval);
    }
  }

  /**
   * Ensures that the backup directory exists.
   * @throws {InternalError} If an error occurs while creating the backup directory.
   */
  #ensureBackupDirExists(): void {
    try {
      if (fs.existsSync(this.backupDir)) {
        this.logger.debug('Backup directory already exists.');
      } else {
        fs.mkdirSync(this.backupDir, { recursive: true });
        this.logger.debug('Backup directory created');
      }
    } catch (error) {
      throw new InternalError(
        `Error accessing or creating backup directory: ${(error as Error).message}`
      );
    }
  }

  /**
   * Checks if backup files for this instance exist.
   * @returns `true` if backup files exist, `false` otherwise.
   */
  backupExists(): boolean {
    const files = [this.backupCurrentPath, this.backupPreviousPath, this.backupTempFilePath];
    return files.some((file) => {
      try {
        return fs.existsSync(file) && fs.statSync(file).size > 0;
      } catch {
        return false;
      }
    });
  }

  /**
   * Backup the filter with retries.
   * @param filter - The filter to backup.
   * @param generation - Filter generation at schedule time; the backup is
   * skipped if the filter has rotated since.
   * @throws {InternalError} If an error occurs while backing up the filter.
   * @throws {InternalError} If the maximum number of retries is reached.
   */
  async #backupWithRetry(filter: BloomFilter, generation: number): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 secondes

    for (let i = 0; i < maxRetries; i++) {
      if (generation !== this.#generation) {
        this.logger.debug('Skipping periodic backup: filter rotated since it was scheduled.');
        return;
      }
      try {
        await this.#backup(filter, generation);
        return;
      } catch (error) {
        this.logger.error(`Backup failed (attempt ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    // Never stop the interval — the next tick will retry naturally.
    // The backup is restarted on every rotation anyway, so a permanent
    // stop here would be silently recovered later.
    this.logger.error(`Max retries reached for this backup cycle. Will retry on next interval.`);
  }

  /**
   * Starts the Bloom filter backup interval.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filter.
   */
  startBackupInterval(filter: BloomFilter): void {
    let remainingbackup = this.backupRatioTime - 1; //number of backup remaining before rotation
    const generation = this.#generation;
    this.backupInterval = setInterval(async () => {
      if (remainingbackup > 0) {
        // No backup on the last iteration because it will be backuped with the rotation and reinitialized
        await this.#backupWithRetry(filter, generation);
        remainingbackup--;
      }
    }, this.rotateTime / this.backupRatioTime);
  }

  /**
   * Stops the Bloom filter backup interval.
   */
  stopBackupInterval(): void {
    if (this.backupInterval !== null) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
      this.logger.debug(`Backup stopped for id: ${this.id}`);
    }
  }

  /**
   * Stops the Bloom filter rotation interval.
   */
  stopWriteInterval(): void {
    if (this.writeInterval !== null) {
      clearInterval(this.writeInterval);
      this.writeInterval = null;
      this.logger.debug(`Write interval stopped for id: ${this.id}`);
    }
  }

  /**
   * Backup a single token to the temporary file (synchronous for crash safety).
   *
   * Retries up to 3 times on failure before letting the error propagate.
   * No delay between retries to preserve the synchronous crash-safety model:
   * the entire `add()` call must complete before the process can yield.
   *
   * When `bufferEnabled` is true, the token is pushed to an in-memory buffer
   * and flushed asynchronously — see `#flushWriteBuffer()`.
   *
   * @param filterItem - The value to add.
   */
  backupItem(filterItem: string): void {
    if (this.bufferEnabled) {
      if (this.writeBuffer.length >= this.maxBufferSize) {
        throw new InternalError(
          `Write buffer full (${this.maxBufferSize} items). ` +
            `Disk may be unavailable — tokens are not being persisted. ` +
            `Token NOT added to buffer.`
        );
      }
      this.writeBuffer.push(filterItem);
      return;
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        fs.appendFileSync(this.backupTempFilePath, `${filterItem}\n`);
        return;
      } catch (error) {
        const err = error as Error;
        if (attempt < maxRetries - 1) {
          this.logger.warn(
            `Temp file write failed (attempt ${attempt + 1}/${maxRetries}): ${err.message}`
          );
        } else {
          this.#writeAuditLog(`FAILED_TO_PERSIST: ${filterItem}`, err);
          throw error;
        }
      }
    }
  }

  /**
   * Public wrapper around the private flush for use during graceful shutdown.
   */
  async flushWriteBuffer(): Promise<void> {
    await this.#flushWriteBuffer();
  }

  /**
   * Last-resort audit trail: writes to stderr so that a token is never
   * completely invisible, even when all file I/O has failed.
   *
   * This is NOT a substitute for proper persistence — tokens written here
   * are lost on restart. It exists so that an operator can reconstruct
   * revocations manually from the process logs.
   */
  #writeAuditLog(token: string, error: Error): void {
    const ts = new Date().toISOString();
    process.stderr.write(
      `[TOKEN-REVOKER:${this.id}] ${ts} | ${token} | reason: ${error.message}\n`
    );
  }

  /**
   * Flushes the write buffer to the temp file.
   *
   * The buffer is cleared ONLY after a successful write, so a failure does not
   * lose data — tokens stay in the buffer and will be retried on the next flush
   * interval.
   */
  async #flushWriteBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) {
      return;
    }
    const data = `${this.writeBuffer.join('\n')}\n`;
    try {
      await fs.promises.appendFile(this.backupTempFilePath, data);
      this.writeBuffer = [];
      this.logger.debug(`Buffer flushed for instance ${this.id}`);
    } catch (error) {
      const err = error as Error;
      this.logger.error(
        `Error writing to temp file (buffer NOT cleared, will retry): ${err.message}`
      );
      // Last-resort audit: write every buffered token to stderr
      for (const item of this.writeBuffer) {
        this.#writeAuditLog(`BUFFER_FLUSH_FAILED: ${item}`, err);
      }
    }
  }

  /**
   * Checks if the temp file exists and is not empty.
   * @returns `true` if the temp file exists and is not empty, `false` otherwise.
   */
  #tempFileExistsAndNotEmpty(): boolean {
    try {
      return (
        fs.existsSync(this.backupTempFilePath) && fs.statSync(this.backupTempFilePath).size > 0
      );
    } catch {
      return false; // Consider that the file does not exist or is empty in case of error
    }
  }

  /**
   * Backup one or all filters to local storage.
   *
   * The blob is written atomically (temp file + fsync + rename) so that a
   * crash can never leave a truncated blob at the final path.
   *
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filter(s).
   */
  async backupLocal(filter: BloomFilter): Promise<void> {
    if (!filter) {
      throw new InternalError(`Current filter is not defined.`);
    }
    try {
      const buffer = Buffer.from((filter.buckets as Int32Array).buffer);
      const tmpPath = `${this.backupCurrentPath}.tmp`;
      const fileHandle = await fs.promises.open(tmpPath, 'w');
      try {
        await fileHandle.writeFile(buffer);
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await fs.promises.rename(tmpPath, this.backupCurrentPath);
      this.logger.debug(`Saved current filter to: ${this.backupCurrentPath}`);
      await fs.promises.writeFile(this.backupTempFilePath, '');
      this.logger.debug(`Temp file cleared for instance ${this.id}`);
    } catch (error) {
      throw new InternalError(
        `Failed to backup current filter to ${this.backupCurrentPath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Backup the current filter, guarded by the mutex and the generation counter.
   * @param filter - The filter to backup.
   * @param generation - Filter generation at schedule time.
   * @throws {InternalError} If an error occurs while backing up the filters.
   */
  async #backup(filter: BloomFilter, generation: number): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      if (generation !== this.#generation) {
        // Rotated while waiting for the mutex — the new generation persists itself.
        return;
      }
      await this.backupLocal(filter);
    } finally {
      release();
    }
  }

  /**
   * Backup the current filter at rotation time, then promote it to previous.
   *
   * Increments the generation counter first so that any in-flight periodic
   * backup for the old filter is invalidated, then waits on the mutex for any
   * write already past its generation check to finish. This closes the race
   * where a stale periodic backup retry could overwrite post-rotation state
   * and truncate the WAL.
   *
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filters.
   */
  async backupRotate(filter: BloomFilter): Promise<void> {
    this.#generation++;
    const release = await this.mutex.acquire();
    try {
      await this.backupLocal(filter);
      if (fs.existsSync(this.backupCurrentPath)) {
        fs.renameSync(this.backupCurrentPath, this.backupPreviousPath);
      }
    } finally {
      release();
    }
  }

  /**
   * Restores elements from the temporary file to the current filter.
   *
   * Malformed or unparsable tokens are skipped with a warning so that a single
   * corrupted line does not prevent the rest of the restore from completing.
   *
   * @param currentFilter - The current filter instance (guaranteed non-null by caller).
   * @throws {InternalError} If the temp file cannot be read at all (I/O error).
   */
  #restoreTemp(currentFilter: BloomFilter): void {
    try {
      const fileContent = fs.readFileSync(this.backupTempFilePath, 'utf8');
      const lines = fileContent.split('\n');
      let skippedCount = 0;

      for (const line of lines) {
        if (line.trim()) {
          try {
            currentFilter.add(line);
          } catch (error) {
            skippedCount++;
            this.logger.warn(
              `Skipping malformed token during restore: '${line.slice(0, 50)}': ${(error as Error).message}`
            );
          }
        }
      }

      if (skippedCount > 0) {
        this.logger.warn(
          `Skipped ${skippedCount} malformed token(s) during restore for instance ${this.id}`
        );
      }
      this.logger.debug(`Elements restored from temp file for instance : ${this.id}`);
    } catch (error) {
      throw new InternalError(`Restore temp file failed: ${(error as Error).message}`);
    }
  }

  /**
   * Checks that a blob on disk matches the geometry of the configured filter.
   * Protects against torn (mid-write) blobs and configuration changes between
   * restarts, which would otherwise silently restore wrong filter bits.
   */
  #hasExpectedGeometry(buffer: Buffer): boolean {
    if (buffer.length % Int32Array.BYTES_PER_ELEMENT !== 0) {
      return false;
    }
    const m = Math.ceil(
      (-this.filterParams.numItems * Math.log2(this.filterParams.fpRate)) / Math.LN2
    );
    const expectedBuckets = Math.ceil(m / 32);
    return buffer.length / Int32Array.BYTES_PER_ELEMENT === expectedBuckets;
  }

  /**
   * Restores a single filter from a file.
   *
   * A blob whose size does not match the configured filter geometry (torn
   * write, or numItems/fpRate changed since the backup) is ignored with a
   * warning instead of breaking startup — the instance starts with an empty
   * filter and replays its WAL.
   *
   * @param filterName - The name of the filter ('current' or 'previous').
   * @param filePath - The path to the backup file.
   * @returns The restored filter instance or null if no usable backup exists.
   * @throws {InternalError} If an error occurs during restoration.
   */
  #restoreFilterFromFile(filterName: string, filePath: string): BloomFilter | null {
    if (fs.existsSync(filePath)) {
      try {
        const buffer = fs.readFileSync(filePath);
        if (!this.#hasExpectedGeometry(buffer)) {
          this.logger.warn(
            `Ignoring ${filterName} backup for id ${this.id}: blob size does not match the configured filter ` +
              `(numItems=${this.filterParams.numItems}, fpRate=${this.filterParams.fpRate}). Starting with an empty filter.`
          );
          return null;
        }
        const buckets = new Int32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / Int32Array.BYTES_PER_ELEMENT
        );
        const restoredFilter = BloomFilterFactory.createFromBuckets(buckets, this.filterParams.k);
        this.logger.debug(`Restored ${filterName} filter : id ${this.id}`);
        return restoredFilter;
      } catch (error) {
        throw new InternalError(
          `Restore failed for ${filterName} filter: ${(error as Error).message}`
        );
      }
    } else {
      this.logger.warn(`No ${filterName} backup to restore for instance : id ${this.id}`);
      return null;
    }
  }

  /**
   * Restores one or all filters from backup files.
   * @param filterName - The name of the filter to restore: 'current', 'previous', or 'all' for both.
   * @returns The restored filters.
   * @throws {ValidationError} If filterName is invalid.
   */
  restore(filterName: string): RestoredFilters {
    // Validation
    const validFilters = ['current', 'previous', 'all'];
    if (!validFilters.includes(filterName)) {
      throw new ValidationError(
        "filterName parameter must be either 'current', 'previous', or 'all'"
      );
    }

    const filtersToRestore: FilterName[] =
      filterName === 'all' ? ['current', 'previous'] : [filterName as FilterName];
    const filterPaths: Record<FilterName, string> = {
      current: this.backupCurrentPath,
      previous: this.backupPreviousPath,
    };

    const restoredFilters: RestoredFilters = { current: null, previous: null };

    for (const name of filtersToRestore) {
      const filePath = filterPaths[name];
      restoredFilters[name] = this.#restoreFilterFromFile(name, filePath);
    }

    if (this.#tempFileExistsAndNotEmpty()) {
      const current =
        restoredFilters.current ??
        BloomFilterFactory.create(this.filterParams.numItems, this.filterParams.fpRate);
      restoredFilters.current = current;
      this.#restoreTemp(current);
    }
    return restoredFilters;
  }

  /**
   * Checks whether the storage backend is healthy by writing and deleting a
   * test file in the backup directory.
   *
   * @returns A health check component result.
   */
  healthCheckStorage(): HealthCheckComponent {
    try {
      this.#ensureBackupDirExists();
      const testFile = path.join(this.backupDir, `.health-check-${randomUUID()}`);
      fs.writeFileSync(testFile, `${Date.now()}\n`);
      fs.unlinkSync(testFile);
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        error: `Storage check failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Deletes a backup file if it exists.
   * @param filePath The path to the backup file.
   * @param fileType The type of backup file (e.g., 'Current', 'Previous').
   * @throws {InternalError} If an error occurs while deleting the backup file.
   */
  deleteBackupFile(filePath: string, fileType: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.debug(`${fileType} backup file deleted for instance : id ${this.id}`);
      }
    } catch (error) {
      throw new InternalError(
        `Error deleting ${fileType} backup file: ${(error as Error).message}`
      );
    }
  }
}
