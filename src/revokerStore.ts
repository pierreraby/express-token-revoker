import type { Revoker } from './index.js';
import type { GenericLogger, RevokerStore as RevokerStoreType } from './types.js';

/**
 * Checks if a revokerInstance has a non-null bloomFilterManager.
 */
function hasNonNullableBloomFilterManager(
  revokerInstance: Revoker | undefined
): revokerInstance is Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> } {
  return !!revokerInstance && !!revokerInstance.bloomFilterManager;
}

const RevokerStore: RevokerStoreType = (() => {
  let instancesMap: Map<string, Revoker> | null = null;

  return {
    /**
     * Initializes the Revoker instances map.
     * @throws If the Revoker instances map is already initialized.
     */
    init(): void {
      if (instancesMap) {
        throw new Error('Revoker instances map is already initialized');
      }
      instancesMap = new Map();
    },

    /**
     * Registers a Revoker instance for management by gRPC.
     * @param revokerInstance - The Revoker instance to register.
     * @throws If the Revoker instances map is not initialized.
     */
    registerInstance(revokerInstance: Revoker): void {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.set(revokerInstance.id, revokerInstance);
      revokerInstance.logger.info(`Revoker instance ${revokerInstance.id} registered`);
    },

    /**
     * Unregisters a Revoker instance for management by gRPC.
     * @param revokerId - The ID of the Revoker instance to unregister.
     * @throws If the Revoker instances map is not initialized.
     */
    unregisterInstance(revokerId: string): void {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.delete(revokerId);
    },

    /**
     * Finds a Revoker instance by ID.
     * @param revokerId - The ID of the Revoker instance.
     * @param logger - The logger instance.
     */
    findInstance(revokerId: string, logger: GenericLogger) {
      const revokerInstance = instancesMap ? instancesMap.get(revokerId) : undefined;
      if (!hasNonNullableBloomFilterManager(revokerInstance)) {
        // debug, not error: probing unknown ids is expected client behavior
        // and error-level logging would spam on every miss.
        logger.debug('Revoker instance or Bloom filter not found');
        return undefined;
      }
      return revokerInstance;
    },

    /**
     * Lists all registered Revoker instances Id.
     * @throws If the Revoker instances map is not initialized.
     */
    listInstances(): string[] {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      return Array.from(instancesMap.keys());
    },

    /**
     * Destroys the Revoker instances map.
     * @throws If the Revoker instances map is not initialized.
     */
    destroy(): void {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.clear();
      instancesMap = null;
    },

    /**
     * Store is empty
     * @throws If the Revoker instances map is not initialized.
     */
    isEmpty(): boolean {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      return instancesMap.size === 0;
    },
  };
})();

Object.freeze(RevokerStore);
export default RevokerStore;
