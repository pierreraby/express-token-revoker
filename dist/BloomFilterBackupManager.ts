import fs from 'fs';
import path from 'path';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { InternalError, ValidationError } from './errors.js';
import { Mutex } from 'async-mutex';
import { BloomFilterFactory } from './BloomFilterFactory.js';
import type { BloomFilter } from './bloomfilter.js';
import type { GenericLogger } from './types.js';
import type { BloomFilterOptions } from './Bloom-filter-manager.js';

// Define __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  writeInterval: NodeJS.Timeout | null;
  bufferFlushInterval: number;
  mutex: Mutex;

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

    this.backupDir = options.backupDir || path.resolve(__dirname, '../backup');
    this.backupCurrentPath = path.join(this.backupDir, `current-${this.id}.blob`);
    this.backupPreviousPath = path.join(this.backupDir, `previous-${this.id}.blob`);
    this.backupTempFilePath = path.join(this.backupDir, `temp-${this.id}.txt`);

    this.mutex = new Mutex();

    this.bufferEnabled = options.bufferEnabled ?? false;
    this.writeBuffer = [];
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
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        this.logger.debug('Backup directory created');
      } else {
        this.logger.debug('Backup directory already exists.');
      }
    } catch (error) {
      throw new InternalError(`Error accessing or creating backup directory: ${error.message}`);
    }
  }

  /**
   * Checks if backup files exist.
   * @returns `true` if backup files exist, `false` otherwise.
   */
  backupExists(): boolean {
    try {
      return fs.existsSync(this.backupDir) && fs.readdirSync(this.backupDir).length > 0;
    } catch (error) {
      return false; // Consider that the backup does not exist in case of an error
    }
  }

  /**
   * Backup the filter with retries.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filter.
   * @throws {InternalError} If the maximum number of retries is reached.
   */
  async #backupWithRetry(filter: BloomFilter): Promise<void> {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 secondes

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.#backup(filter);
        return;
      } catch (error) {
        this.logger.error(`Backup failed (attempt ${i + 1}/${maxRetries}):`, error);
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
    this.logger.error('Max retries reached. Stopping backup.');
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
    }
  }

  /**
   * Starts the Bloom filter backup interval.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filter.
   */
  startBackupInterval(filter: BloomFilter): void {
    let remainingbackup = this.backupRatioTime - 1; //number of backup remaining before rotation
    this.backupInterval = setInterval(async () => {
      if (remainingbackup > 0) {
        // No backup on the last iteration because it will be backuped with the rotation and reinitialized
        await this.#backupWithRetry(filter);
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
  stoptWriteInterval(): void {
    if (this.writeInterval !== null) {
      clearInterval(this.writeInterval);
      this.writeInterval = null;
      this.logger.debug(`Rotation stopped for id: ${this.id}`);
    }
  }

  /**
   * Backup the filter
   * @param filterItem - The value to add.
   */
  backupItem(filterItem: string): void {
    if (this.bufferEnabled) {
      this.writeBuffer.push(filterItem);
      // if (this.writeBuffer.length >= MAX_BUFFER_SIZE) {
      //   this.#flushWriteBuffer();
      // }
    } else {
      fs.appendFileSync(this.backupTempFilePath, `${filterItem}\n`);
    }
  }

  /**
   * Flushes the write buffer to the temp file.
   * @throws {InternalError} If an error occurs while writing to the temp file.
   */
  async #flushWriteBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) {
      return;
    }
    const data = this.writeBuffer.join('\n') + '\n';
    this.writeBuffer = []; // Vider le buffer AVANT l'écriture
    try {
      await fs.promises.appendFile(this.backupTempFilePath, data);
      this.logger.debug(`Buffer flushed for instance ${this.id}`);
    } catch (error) {
      this.logger.error('Error writing to temp file:', error);
      // Handle the error (e.g., retry later, or stop the backup)
      // IMPORTANT: If the write fails, the data is *lost*.
      // You might consider putting it back into the buffer, but be cautious of infinite loops.
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
    } catch (error) {
      return false; // Consider that the file does not exist or is empty in case of error
    }
  }

  /**
   * Backup one or all filters to local storage.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filter(s).
   */
  async backupLocal(filter: BloomFilter): Promise<void> {
    if (!filter) {
      throw new InternalError(`Current filter is not defined.`);
    }
    try {
      const buffer = Buffer.from((filter.buckets as Int32Array).buffer);
      await fs.promises.writeFile(this.backupCurrentPath, buffer);
      this.logger.debug(`Saved current filter to: ${this.backupCurrentPath}`);
      await fs.promises.writeFile(this.backupTempFilePath, '');
      this.logger.debug(`Temp file cleared for instance ${this.id}`);
    } catch (error) {
      throw new InternalError(
        `Failed to backup current filter to ${this.backupCurrentPath}: ${error.message}`
      );
    }
  }

  /**
   * Backup the current and previous filters.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filters.
   */
  async #backup(filter: BloomFilter): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      await this.backupLocal(filter);
    } catch (error) {
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Backup the current and previous filters.
   * @param filter - The filter to backup.
   * @throws {InternalError} If an error occurs while backing up the filters.
   */
  async backupRotate(filter: BloomFilter): Promise<void> {
    try {
      await this.backupLocal(filter);
      if (fs.existsSync(this.backupCurrentPath)) {
        fs.renameSync(this.backupCurrentPath, this.backupPreviousPath); // Vous pourriez envisager de gérer les erreurs ici également
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Restores elements from the temporary file to the current filter.
   * @param currentFilter - The current filter instance.
   * @throws {InternalError} If an error occurs while restoring the filter.
   */
  #restoreTemp(currentFilter: BloomFilter): void {
    try {
      const fileContent = fs.readFileSync(this.backupTempFilePath, 'utf8');
      const lines = fileContent.split('\n');

      for (const line of lines) {
        if (line.trim()) {
          try {
            if (currentFilter) {
              currentFilter.add(line);
            } else {
              // This situation should not occur as `current` is initialized
              throw new InternalError(
                `Cannot add '${line}' to current filter: filter not initialized.`
              );
            }
          } catch (error) {
            throw new InternalError(`Failed to add '${line}' to Bloom filter: ${error.message}`);
          }
        }
      }

      this.logger.debug(`Elements restored from temp file for instance : ${this.id}`);
    } catch (error) {
      throw new InternalError(`Restore temp file failed: ${error.message}`);
    }
  }

  /**
   * Restores a single filter from a file.
   * @param filterName - The name of the filter ('current' or 'previous').
   * @param filePath - The path to the backup file.
   * @returns The restored filter instance or null if no backup exists.
   * @throws {InternalError} If an error occurs during restoration.
   */
  #restoreFilterFromFile(filterName: string, filePath: string): BloomFilter | null {
    if (fs.existsSync(filePath)) {
      try {
        const buffer = fs.readFileSync(filePath);
        const buckets = new Int32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / Int32Array.BYTES_PER_ELEMENT
        );
        const restoredFilter = BloomFilterFactory.createFromBuckets(buckets, this.filterParams.k);
        this.logger.debug(`Restored ${filterName} filter : id ${this.id}`);
        return restoredFilter;
      } catch (error) {
        throw new InternalError(`Restore failed for ${filterName} filter: ${error.message}`);
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
      throw new InternalError(`Error deleting ${fileType} backup file: ${error.message}`);
    }
  }

  // ... (Toutes les méthodes liées à la sauvegarde et à la restauration) ...
  // #backup, #backupLocal, #restore, #restoreTemp, #deleteBackupFile,
  // #ensureBackupDirExists, #tempFileExistsAndNotEmpty, #flushWriteBuffer (pour l'écriture bufferisée)

  //async #flushWriteBuffer() { /* ... */ } // Implémentation de l'écriture asynchrone par lots
  //startBackupInterval() { /* ... */ } // Méthode pour démarrer l'intervalle de backup
  //stopBackup() { /* ... */ } // Méthode pour arrêter l'intervalle de backup
  async appendToTempFile(data: string): Promise<void> {
    /* ... */
  } // Méthode pour ajouter des données au buffer
}
