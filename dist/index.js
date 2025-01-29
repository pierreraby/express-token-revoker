// @ts-check
import './types.js';

/**
 * @typedef {import('./types.js').GenericLogger} GenericLogger
 */

/**
 * @typedef {Object} JWTPayload
 * @property {string} [iss] - Issuer claim.
 * @property {string} [sub] - Subject claim.
 * @property {string} [aud] - Audience claim.
 * @property {string} [exp] - Expiration time claim.
 * @property {string} [nbf] - Not before claim.
 * @property {string} [iat] - Issued at claim.
 * @property {string} [jti] - JWT ID claim.
 * @property {any} [anyOtherClaim] - Allows adding additional claims.
 */

// /**
//  * @typedef {import('express').Request & { token?: JWTToken }} RequestWithToken
//  */

import { BloomFilterManager } from "./Bloom-filter-manager.js";
import { ValidationError, InternalError } from './errors.js';
import throttle from "throttleit";
import { stopServer, registerRevokerInstance, startServer } from "./grpc/std-server.js";
import { revokerInputSchema } from "./Inputs-validation.js";

/**
   * Logs or throttles messages based on the environment.
   * @param {string} message - The message to log or throttle.
   * @param {Function} throttleFn - Throttle function.
   * @param {GenericLogger} logger - Any logger implementing the basic logging methods
   * @param {boolean} [isError=false] - True if the message is an error.
   * @returns {void}
   */
const logOrThrottle = (message, throttleFn, logger, isError = false) => {
  try {
    if (process.env.NODE_ENV !== 'development') {
      throttleFn(message);
    } else {
      logger[isError ? 'warn' : 'info'](message);
    }
  } catch (error) {
    logger.error("Error in logOrThrottle:", error);
  }
};

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {string[]} claimsToCheck - List of claims to check.
 * @param {string} payloadKey - The key to get the token payload from the request.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {GenericLogger} logger - Any logger implementing the basic logging methods
 * @param {Function} throttleJWT - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
const createJWTMiddleware = (claimsToCheck, payloadKey, bloomFilterManager, logger, throttleJWT) => {

  /**
   * Validates the presence of the JWT payload.
   * @param {JWTPayload | undefined} payload - The JWT payload to validate.
   * @returns {payload is JWTPayload} - True if token is valid, throws otherwise
   * @throws {Error} If the payload is missing.
   */
  const validatePayload = (payload) => {
    if (!payload) {
      throw new ValidationError("Missing JWT payload in request");
    }
    return true;
  };

  /**
   * Validates a specific claim in the JWT payload.
   * @param {JWTPayload} payload - The JWT payload to validate.
   * @param {string} claim - The claim to validate.
   * @throws {Error} If the claim is missing or blacklisted.
   */
  const validateClaim = (payload, claim) => {
    if (!payload[claim]) {
      throw new ValidationError(`Missing ${claim} claim in JWT Payload`);
    }

    if (bloomFilterManager.has(`${claim}-${payload[claim]}`)) {
      logOrThrottle(`Token ${claim}-${payload[claim]} is blacklisted`, throttleJWT, logger, false);
      return false;
    }
    return true;
  };

  /**
   * Validates all specified claims in the JWT token.
   * @param {JWTPayload} payload - The JWT payload to validate.
   * @param {string[]} claims - The claims to validate.
   */
  const validateAllClaims = (payload, claims) => {
    return claims.every(claim => validateClaim(payload, claim));
  };

  /**
   * Express middleware to validate JWT tokens against a Bloom filter.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  return (req, res, next) => {
    try {
      const decodedPayload = req[payloadKey];

      if (validatePayload(decodedPayload) && validateAllClaims(decodedPayload, claimsToCheck)) {
        next();
      } else {
        res.status(401).json({
          error: "invalid_token",
          message: `Invalid token!`,
        });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        logger.warn(`Validation error: ${error.message}`);
        res.status(400).json({
          error: "validation_error",
          message: error.message,
        });
      } else {
        logger.error(`Unexpected error during JWT validation: ${error.message}`);
        res.status(500).json({
          error: "internal_error",
          message: "An unexpected error occurred",
        });
      }
    }
  };
};

/**
 * Middleware factory to check opaque token with the Bloom filter.
 * @param {string} header - The header to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {GenericLogger} logger - Any logger implementing the basic logging methods
 * @param {Function} throttleOpaque - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
const createOpaqueMiddleware = (header, bloomFilterManager, logger, throttleOpaque) => {

    /**
   * Extracts the token from the request headers.
   * @param {import('express').Request} req - Express request object.
   * @param {string} normalizedHeader - The normalized header name.
   * @returns {string} The extracted token.
   * @throws {Error} If the header is missing or invalid.
   */
  const extractToken = (req, normalizedHeader) => {
    const headerValue = req.headers[normalizedHeader];
    
    if (!headerValue) {
      throw new ValidationError(`Missing header: ${normalizedHeader}`);
    }

    if (normalizedHeader === "authorization") {
      // Ensure headerValue is a string
      const authHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      const [type, token] = authHeader.split(" ");
      
      if (!token || type.toLowerCase() !== "bearer") {
        throw new ValidationError('Invalid authorization header format. Expected "Bearer <token>"');
      }
      return token;
    }

    // For other headers, take the first value if it's an array
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  };

  /**
   * Validates the token against the Bloom filter.
   * @param {string} token - The token to validate.
   * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
   * @throws {Error} If the token is blacklisted.
   */
  const validateToken = (token, bloomFilterManager) => {
    if (token && bloomFilterManager.has(token)) {
      logOrThrottle(`Token ${token} is blacklisted`, throttleOpaque, logger, false);
      return false;
    }
    return true;
  };
  
  /**
   * Express middleware to validate Opaques tokens/ API KEYS against a Bloom filter.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  return (req, res, next) => {
    try {
      const normalizedHeader = header.toLowerCase();
      const token = extractToken(req, normalizedHeader);
      if (validateToken(token, bloomFilterManager)) {
        next();
      } else {
        res.status(401).json({
          error: "invalid_token",
          message: `Invalid token!`,
        });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        logger.warn(`Validation error: ${error.message}`);
        res.status(400).json({
          error: "validation_error",
          message: error.message
        });
      } else {
        logger.error(`Unexpected error during opaque token validation: ${error.message}`);
        res.status(500).json({
          error: "internal_error",
          message: "An unexpected error occurred",
        });
      }
    }
  };
};

/**
 * @typedef {import('express').RequestHandler} RequestHandler
*/

/**
 * Revoker class to manage middleware and adding items to the Bloom filter.
 */
export class Revoker {
  
  /** @type {BloomFilterManager | null} */
  bloomFilterManager = null;

  /** @type {RequestHandler | null} */
  middleware = null;

  /** @type {string} */
  id;

  /** @type {GenericLogger} */
  logger;

  /** @type {boolean} */
  grpcEnabled;

  /** @type {boolean} */
  static grpcServerStarted = false;

  /**
   * @typedef {Object} FilterConfig
   * @property {number} numItems - Number of items to store in the Bloom filter
   * @property {number} fpRate - Target false positive rate for the Bloom filter
   * @property {number} rotateTime - Rotation interval in milliseconds
   * @property {boolean} [backup] - whether to enable backup
   * @property {number} [backupTime] - Backup interval in milliseconds
   */
  
  /**
   * @typedef {Object} ConfigBase
   * @property {string} id - The ID of the Revoker instance.
   * @property {GenericLogger} logger - Any logger implementing the basic logging methods
   * @property {boolean} [grpcEnabled] - Whether to enable gRPC.
   * @property {string} [grpcPort] - The port for the gRPC server.
   * @property {FilterConfig} filter - Configuration options for the Bloom filter.
   * @typedef {ConfigBase & { claimsToCheck: Array<string>, payloadKey: string, opaqueHeader?: never }} JWTConfig
   * @typedef {ConfigBase & { opaqueHeader: string, claimsToCheck?: never, payloadKey?: never }} OpaqueConfig
   * @typedef {JWTConfig | OpaqueConfig} Config
   */

  /**
   * @param {Config} config - Configuration options.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  constructor(config) {

    const { error } = revokerInputSchema.validate(config);
    if (error) {
      throw new ValidationError(`Invalid input: ${error.message}`);
    }

    const {
      id, claimsToCheck, payloadKey, opaqueHeader, grpcEnabled = false, grpcPort, logger = console, filter
    } = config;   

    try {
      this.bloomFilterManager = new BloomFilterManager({ id, logger, ...filter });
    } catch (error) {
      throw new InternalError(`Failed to initialize BloomFilterManager: ${error.message}`);
    }

    const throttleLog = throttle((message) => logger.info(message), 60000);

    this.id = id;
    this.logger = logger;

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(
        claimsToCheck,
        payloadKey,
        this.bloomFilterManager,
        logger,
        throttleLog
      );
    } else if (opaqueHeader) {
      this.middleware = createOpaqueMiddleware(
        opaqueHeader,
        this.bloomFilterManager,
        logger,
        throttleLog,
      );
    } else {
      this.bloomFilterManager.destroy();
      throw new ValidationError("claimsToCheck or opaqueHeader must be provided");
    }

    this.grpcEnabled = grpcEnabled;

    if (this.grpcEnabled) {
      registerRevokerInstance(this);
      if (!Revoker.grpcServerStarted && grpcPort) {
        logger.info(`Starting gRPC server with id:  ${this.id}`);
        logger.info(`grpcEnabled: ${this.grpcEnabled}`);
        startServer(grpcPort, logger);
        Revoker.grpcServerStarted = true;
      }
    }
  }

  /**
   * Returns the configured middleware.
   * @returns {RequestHandler} Middleware Express.
   * @throws {Error} If the middleware is not configured.
   */
  getMiddleware() {
    if (!this.middleware) {
      throw new Error("Middleware not configured");
    }
    return this.middleware;
  }

  /**
   * Adds an item to the Bloom filter.
   * @param {string} filterItem - The item to add.
   * @returns {void}
   * @throws {Error} If the item is invalid.
   */
  add(filterItem) {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    try {
      this.bloomFilterManager.add(filterItem);
    } catch (error) {
      this.logger.error('Error in Revoker.add:', error);
      throw error;
    }
  }

  /**
   * Checks if an item exists in the Bloom filter.
   * @param {string} item - The item to check.
   * @returns {boolean} True if the item may exist, false otherwise.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  has(item) {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    try {
      return this.bloomFilterManager.has(item);
    } catch (error) {
      this.logger.error('Error in Revoker.has:', error);
      throw error;
    }
  }

  /**
   * Get metrics for the Bloom filter.
   * @returns {Object} Metrics object.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  getMetrics() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }
    
    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }
  
    return this.bloomFilterManager.getMetrics();
  }

  /**
   * Resets and restore the Bloom filter.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs during the reset or restoration.
   */
  async resetAndRestore() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }

    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }

    try {
      await this.bloomFilterManager.resetAndRestore();
      this.logger.info("Bloom filter has been reset and restored successfully.");
    } catch (error) {
      this.logger.error('Error in Revoker.resetAndRestore:', error);
      throw error;
    }
  }

  /**
   * Resets the Bloom filter and clears data.
   * @returns {Promise<void>}
   * @throws {Error} If an error occurs during the reset or data clearance.
   */
  async resetAndClearData() {
    if (this.grpcEnabled) {
      throw new Error("gRPC is enabled, use the gRPC method instead");
    }

    if (!this.bloomFilterManager) {
      throw new Error("Bloom filter manager not initialized");
    }

    try {
      await this.bloomFilterManager.resetAndClearData();
      this.logger.info("Bloom filter has been reset and data cleared successfully.");
    } catch (error) {
      this.logger.error('Error in revoker.resetAndClearData:', error);
      throw error;
    }
  }

  /**
   * Destroys the Bloom filter manager.
   * @returns {Promise<void>}
   */
  async destroy() {
    try {
      if (this.grpcEnabled && Revoker.grpcServerStarted) {
        this.logger.info("Stopping gRPC server");
        await stopServer(this.logger);
        this.grpcEnabled = false;
        Revoker.grpcServerStarted = false;
      }
      if (this.bloomFilterManager) {
        this.bloomFilterManager.destroy();
        this.middleware = null;
        this.bloomFilterManager = null;
      } else {
        this.logger.warn("Bloom filter manager already destroyed");
      }
    } catch (error) {
      this.logger.error("Error during Revoker destruction:", error);
      throw new InternalError(`Failed to destroy Revoker: ${error.message}`);
    }
  }
}



