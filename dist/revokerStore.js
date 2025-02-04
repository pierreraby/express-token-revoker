// @ts-check

/**
 * @typedef {import('./index.js').Revoker} Revoker
 * @typedef {import('./types.js').GenericLogger} GenericLogger
 */

/**
 * @typedef {Object} RevokerStore
 * @property {() => void} init - Initializes the Revoker instances map.
 * @property {(revokerInstance: Revoker) => void} registerInstance - Registers a revoker instance.
 * @property {(revokerId: string) => void} unregisterInstance - Unregisters a revoker instance.
 * @property {(revokerId: string, logger: GenericLogger) => (Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }) | undefined} findInstance - Finds a revoker instance by ID.
 * @property {() => String[]} listInstances - Lists all registered revoker instances.
 * @property {() => void} destroy - Destroys the Revoker instances map.
 * @property {() => boolean} isEmpty - Store is empty
 */

/**
 * Checks if a revokerInstance has a non-null bloomFilterManager.
 * @param {Revoker | undefined} revokerInstance
 * @returns {revokerInstance is Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }}
 */
  function hasNonNullableBloomFilterManager(revokerInstance) {
    return !!revokerInstance && !!revokerInstance.bloomFilterManager;
  }

/** @type {RevokerStore} */
  const RevokerStore = (() => {
    /** @type {Map<string, Revoker> | null} */
    let instancesMap = null;

return {
    /**
     * Initializes the Revoker instances map.
     * @returns {void}
     * @throws {Error} If the Revoker instances map is already initialized.
     */
    init() {
      if (instancesMap) {
        throw new Error('Revoker instances map is already initialized');
      }
      instancesMap = new Map();
    },

    /**
     * Registers a Revoker instance for management by gRPC.
     * @param {Revoker} revokerInstance - The Revoker instance to register.
     * @returns {void}
     * @throws {Error} If the Revoker instances map is not initialized.
     */
    registerInstance(revokerInstance) {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.set(revokerInstance.id, revokerInstance);
      revokerInstance.logger.info(`Revoker instance ${revokerInstance.id} registered`);
    },

    /**
     * Unregisters a Revoker instance for management by gRPC.
     * @param {string} revokerId - The ID of the Revoker instance to unregister.
     * @returns {void}
     * @throws {Error} If the Revoker instances map is not initialized.
     */
    unregisterInstance(revokerId) {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.delete(revokerId);
    },

    /**
     * Finds a Revoker instance by ID.
     * @param {string} revokerId - The ID of the Revoker instance.
     * @param {GenericLogger} logger - The logger instance.
     * @returns {(Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }) | undefined}
     */
    findInstance(revokerId, logger) {
      const revokerInstance = instancesMap ? instancesMap.get(revokerId) : undefined;
      if (!hasNonNullableBloomFilterManager(revokerInstance)) {
        logger.error('Revoker instance or Bloom filter not found');
        return undefined;
      }
      return revokerInstance;
    },

    /**
     * Lists all registered Revoker instances Id.
     * @returns {string[]}
     * @throws {Error} If the Revoker instances map is not initialized.
     */
    listInstances() {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      return Array.from(instancesMap.keys()); 
    },

    /**
     * Destroys the Revoker instances map.
     * @returns {void}
     * @throws {Error} If the Revoker instances map is not initialized.
     */
    destroy() {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      instancesMap.clear();
      instancesMap = null;
    },

    /**
     * Store is empty
     * @returns {boolean}
     * @throws {Error} If the Revoker instances map is not initialized.
     */
    isEmpty() {
      if (!instancesMap) {
        throw new Error('Revoker instances map is not initialized');
      }
      return instancesMap.size === 0;
    }
  }

})();

Object.freeze(RevokerStore);
export default RevokerStore;