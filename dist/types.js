/**
 * @typedef {Object} GenericLogger
 * @property {function(...any): void} error - Log an error message
 * @property {function(...any): void} warn - Log a warning message
 * @property {function(...any): void} info - Log an info message
 * @property {function(...any): void} debug - Log a debug message
 */

/**
 * @typedef {Object} RevokerStore
 * @property {() => void} init - Initializes the Revoker instances map.
 * @property {(revokerInstance: Revoker) => void} registerInstance - Registers a revoker instance.
 * @property {(revokerId: string) => void} unregisterInstance - Unregisters a revoker instance.
 * @property {(revokerId: string, logger: GenericLogger) => (Revoker & { bloomFilterManager: NonNullable<Revoker['bloomFilterManager']> }) | undefined} findInstance - Finds a revoker instance by ID.
 * @property {() => String[]} listInstances - Lists all registered revoker instances Id.
 * @property {() => void} destroy - Destroys the Revoker instances map.
 * @property {() => boolean} isEmpty - Store is empty
 */

export {};