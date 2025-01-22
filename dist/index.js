// @ts-check

/**
 * @typedef {Object} GenericLogger
 * @property {function(...any): void} error - Log an error message
 * @property {function(...any): void} warn - Log a warning message
 * @property {function(...any): void} info - Log an info message
 * @property {function(...any): void} debug - Log a debug message
 * @property {function(...any): void} trace - Log a trace message
 */

/**
 * @typedef {Object} JWTToken
 * @property {string} [iss] - Issuer claim.
 * @property {string} [sub] - Subject claim.
 * @property {string} [aud] - Audience claim.
 * @property {string} [exp] - Expiration time claim.
 * @property {string} [nbf] - Not before claim.
 * @property {string} [iat] - Issued at claim.
 * @property {string} [jti] - JWT ID claim.
 * @property {any} [anyOtherClaim] - Allows adding additional claims.
 */

/**
 * @typedef {import('express').Request & { token?: JWTToken }} RequestWithToken
 */

import { BloomFilterManager } from "./Bloom-filter-manager.js";
import throttle from "throttleit";
import { registerRevokerInstance, startServer } from "./grpc/standalone-server.js";

/**
   * Logs or throttles messages based on the environment.
   * @param {string} message - The message to log or throttle.
   * @param {Function} throttleFn - Throttle function.
   * @param {GenericLogger} logger - Any logger implementing the basic logging methods
   * @param {boolean} [isError=false] - True if the message is an error.
   * @returns {void}
   */
const logOrThrottle = (message, throttleFn, logger, isError = false) => {
  if (process.env.NODE_ENV !== 'development') {
    throttleFn(message);
  } else {
    logger[isError ? 'warn' : 'info'](message);
  }
};

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {string[]} claimsToCheck - List of claims to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {GenericLogger} logger - Any logger implementing the basic logging methods
 * @param {GenericLogger} logger - Any logger implementing the basic logging methods
 * @param {Function} throttleJWT - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
const createJWTMiddleware = (claimsToCheck, bloomFilterManager, logger, throttleJWT) => {

  /**
   * Validates the presence of the token.
   * @param {JWTToken | undefined} token - The JWT token to validate.
   * @returns {token is JWTToken} - True if token is valid, throws otherwise
   * @throws {Error} If the token is missing.
   */
  const validateToken = (token) => {
    if (!token) {
      logger.info("Missing jwt token");
      return false;
    }
    return true;
  };

  /**
   * Validates a specific claim in the JWT token.
   * @param {JWTToken} token - The JWT token to validate.
   * @param {string} claim - The claim to validate.
   * @throws {Error} If the claim is missing or blacklisted.
   */
  const validateClaim = (token, claim) => {
    if (!token[claim]) {
      logger.info(`Missing ${claim} claim in JWT token`);
      return false;
    }

    if (bloomFilterManager.has(`${claim}-${token[claim]}`)) {
      logOrThrottle(`Token ${claim}-${token[claim]} is blacklisted`, throttleJWT, logger, false);
      return false;
    }
    return true;
  };

  /**
   * Validates all specified claims in the JWT token.
   * @param {JWTToken} token - The JWT token to validate.
   * @param {string[]} claims - The claims to validate.
   */
  const validateAllClaims = (token, claims) => {
    return claims.every(claim => validateClaim(token, claim));
  };

  /**
   * Express middleware to validate JWT tokens against a Bloom filter.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  return (req, res, next) => {
    try {
      /** @type {RequestWithToken} */
      const reqWithToken = req;

      if (validateToken(reqWithToken.token) && validateAllClaims(reqWithToken.token, claimsToCheck)) {
        next();
      } else {
        res.status(401).json({
          error: "invalid_token",
          message: `Invalid token!`,
        });
      }
    } catch (error) {
      // Handle unexpected errors (e.g., an error in the bloomFilterManager)
      logger.error(`Unexpected error during JWT validation: ${error.message}`);
      res.status(500).json({
        error: "internal_error",
        message: "An unexpected error occurred",
      });
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
      logger.info(`Missing header: ${normalizedHeader}`);
      return '';
    }

    if (normalizedHeader === "authorization") {
      // Ensure headerValue is a string
      const authHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      const [type, token] = authHeader.split(" ");
      
      if (!token || type.toLowerCase() !== "bearer") {
        logger.info('Invalid authorization header');
        return '';
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
      if (token !== '' && validateToken(token, bloomFilterManager)) {
        next();
      } else {
        res.status(401).json({
          error: "invalid_token",
          message: `Invalid token!`,
        });
      }
    } catch (error) {
      // Handle unexpected errors (e.g., an error in the bloomFilterManager)
      logger.error(`Unexpected error during JWT validation: ${error.message}`);
      res.status(500).json({
        error: "internal_error",
        message: "An unexpected error occurred",
      });
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

  /** @type {Function} */
  throttleLog = () => {};

  /** @type {string} */
  id;

  /** @type {boolean} */
  grpcEnabled;

  /** @type {string | undefined} */
  grpcPort;

  /**
   * @typedef {Object} ConfigBase
   * @property {number} numItems - Number of items to store in the Bloom filter.
   * @property {number} fpRate - Target false positive rate for the Bloom filter.
   * @property {number} rotateTime - Rotation interval in milliseconds.
   * @property {string} id - The ID of the Revoker instance.
   * @property {boolean} [backup] - whether to enable backup.
   * @property {number} [backupTime] - Backup interval in milliseconds.
   * @property {GenericLogger} logger - Any logger implementing the basic logging methods
   * @property {boolean} [grpcEnabled] - Whether to enable gRPC.
   * @property {string} [grpcPort] - The port for the gRPC server.
   * @typedef {ConfigBase & { claimsToCheck: Array<string>, opaqueHeader?: never }} JWTConfig
   * @typedef {ConfigBase & { opaqueHeader: string, claimsToCheck?: never }} OpaqueConfig
   * @typedef {JWTConfig | OpaqueConfig} Config
   */

  /**
   * @param {Config} config - Configuration options.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  constructor(config) {
    const { numItems, fpRate, rotateTime, id, claimsToCheck, opaqueHeader, backup, backupTime, logger = console, grpcEnabled = false, grpcPort  } = config;

    this.bloomFilterManager = new BloomFilterManager({
      numItems,
      fpRate,
      rotateTime,
      id,
      backup,
      backupTime,
      logger
    });

    this.throttleLog = throttle((message) => logger.info(message), 60000);

    this.id = id;

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(
        claimsToCheck,
        this.bloomFilterManager,
        logger,
        this.throttleLog,
      );
    } else if (opaqueHeader) {
      this.middleware = createOpaqueMiddleware(
        opaqueHeader,
        this.bloomFilterManager,
        logger,
        this.throttleLog,
      );
    } else {
      this.bloomFilterManager.destroy();
      throw new Error("claimsToCheck or opaqueHeader must be provided");
    }

    this.grpcEnabled = grpcEnabled;
    this.grpcPort = grpcPort;

    if (this.grpcEnabled) {
      registerRevokerInstance(this);
      if (!global.grpcServerStarted && this.grpcPort) {
        console.log("Starting gRPC server with id: ", this.id);
        console.log("grpcEnabled: ", this.grpcEnabled);
        startServer(this.grpcPort);
        global.grpcServerStarted = true;
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
    if (this.bloomFilterManager) {
      try {
        this.bloomFilterManager.add(filterItem);
      } catch (error) {
        throw error;
      }
    } else {
      throw new Error("Bloom filter manager not initialized");
    }
  }

  /**
   * Checks if an item exists in the Bloom filter.
   * @param {string} item - The item to check.
   * @returns {boolean} True if the item may exist, false otherwise.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  has(item) {
    if (this.bloomFilterManager) {
      return this.bloomFilterManager.has(item);
    } else {
      throw new Error("Bloom filter manager not initialized");
    }
  }

  /**
   * Get metrics for the Bloom filter.
   * @returns {Object} Metrics object.
   * @throws {Error} If the Bloom filter manager is not initialized.
   */
  getMetrics() {

      if (this.bloomFilterManager) {
        try {
          return this.bloomFilterManager.getMetrics();
        } catch (error) {
          throw error; 
        }
      } else {
        throw new Error("Bloom filter manager not initialized");
      }
  }

  /**
   * Resets and restore the Bloom filter.
   * @returns {Promise<void>}
   */
  async resetAndRestore() {
    if (this.bloomFilterManager) {
      await this.bloomFilterManager.resetAndRestore();
    } else {
      throw new Error("Bloom filter manager not initialized");
    }
  }

  /**
   * Resets the Bloom filter anc clears data.
   * @returns {Promise<void>}
   */
  async resetAndClearData() {
    if (this.bloomFilterManager) {
      await this.bloomFilterManager.resetAndClearData();
    } else {
      throw new Error("Bloom filter manager not initialized");
    }
  }
  /**
   * Destroys the Bloom filter manager.
   * @returns {void}
   */
  destroy() {
    if (this.bloomFilterManager) {
      this.bloomFilterManager.destroy();
      this.middleware = null;
      this.bloomFilterManager = null;
    }
  }
}



