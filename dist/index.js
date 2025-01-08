// @ts-check

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
import client from 'prom-client';
import throttle from "throttleit";

const revokedJwtReplay = new client.Counter({
  name: 'revoked_jwt_tokens',
  help: 'Number of revoked JWT tokens',
});

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {string[]} claimsToCheck - List of claims to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {import('pino').Logger} logger - Logger instance.
 * @param {Function} throttleJWT - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
*/
const createJWTMiddleware = (claimsToCheck , bloomFilterManager, logger, throttleJWT) => {
   /**
   * Express middleware to validate JWT tokens against a Bloom filter.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  return (req, res, next) => {

      /** @type {RequestWithToken} */
      const reqWithToken = req;


    try {
      if (!reqWithToken.token) {
        logger.error("Missing jwt token");
        throw new Error("Missing jwt token");
      }

      for (const claim of claimsToCheck) {
        if (!reqWithToken.token[claim]) {
          logger.warn(`Missing ${claim} claim in JWT token`);
          throw new Error(`Missing ${claim} claim in JWT token`);
        }

        if (bloomFilterManager.has(`${claim}-${reqWithToken.token[claim]}`)) {
          revokedJwtReplay.inc();
          if (process.env.NODE_ENV !== 'development') {
            throttleJWT(`Token ${claim} is blacklisted`);
          } else {
            logger.info(`Token ${claim} is blacklisted`);
          }
          throw new Error(`Token ${claim} is blacklisted`);
        }
      }
      next();
    } catch (error) {
      logger.info(`Invalid token: ${error.message}`);
      res.status(401).json({
        error: "invalid_token",
        message: `Invalid token! ${error.message}`,
        details: error.details || null,
      });
    }
  };
};

const revokedOpaqueReplay = new client.Counter({
  name: 'revoked_opaque_tokens',
  help: 'Number of revoked opaque tokens',
});

/**
 * Middleware factory to check opaque token with the Bloom filter.
 * @param {string} header - The header to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {import('pino').Logger} logger - Logger instance.
 * @param {Function} throttleOpaque - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
 const createOpaqueMiddleware = (header, bloomFilterManager, logger, throttleOpaque) => {
  /**
   * Express middleware to validate JWT tokens against a Bloom filter.
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  return (req, res, next) => {
    try {
      const normalizedHeader = header.toLowerCase();
      if (!req.headers || !req.headers[normalizedHeader]) {
        if (process.env.NODE_ENV !== 'development') {
          throttleOpaque(`Missing header: ${header}`);
        } else {
          logger.warn(`Missing header: ${header}`);
        }
        throw new Error(`Missing header: ${header}`);
      }
      
      let token;
      if (normalizedHeader === "authorization") {
        // @ts-ignore
        const parts = req.headers.authorization.split(" ");
        if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
          if (process.env.NODE_ENV !== 'development') {
            throttleOpaque('Invalid authorization header');
          } else {
            logger.warn('Invalid authorization header');
          }
          throw new Error('Invalid authorization header');
        }
        token = parts[1];
      } else {
        token = req.headers[normalizedHeader];
      }
      if (typeof token === 'string' && bloomFilterManager.has(token)) {
        revokedOpaqueReplay.inc();
        if (process.env.NODE_ENV !== 'development') {
          throttleOpaque(`Token ${token} is blacklisted`);
        } else {
          logger.info(`Token ${token} is blacklisted`);
        }
        throw new Error(`Token is blacklisted`);
      }
      next();
    } catch (error) {
      logger.info(`Invalid opaque token: ${error.message}`);
      res.status(401).json({
        error: "invalid_token",
        message: `Invalid token! ${error.message}`,
        details: error.details || null,
      });
      throw error;
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
  throttleJWT = () => {};

  /** @type {Function} */
  throttleOpaque = () => {};

  /**
   * @typedef {Object} ConfigBase
   * @property {number} numItems - Number of items to store in the Bloom filter.
   * @property {number} fpRate - Target false positive rate for the Bloom filter.
   * @property {number} rotateTime - Rotation interval in milliseconds.
   * @property {import('pino').Logger} logger - Logger instance. 
   *
   * @typedef {ConfigBase & { claimsToCheck: Array<string>, opaqueHeader?: never }} JWTConfig
   * @typedef {ConfigBase & { opaqueHeader: string, claimsToCheck?: never }} OpaqueConfig
   * @typedef {JWTConfig | OpaqueConfig} Config
   */

  /**
   * @param {Config} config - Configuration options.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  constructor(config) {
    const { numItems, fpRate, rotateTime, claimsToCheck, opaqueHeader, logger } = config;
    this.bloomFilterManager = new BloomFilterManager({
      numItems,
      fpRate,
      rotateTime, // 30 minutes
      logger
    });

    this.throttleJWT = throttle((message) => logger.info(message), 60000);
    this.throttleOpaque = throttle((message) => logger.info(message), 60000);

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(claimsToCheck , this.bloomFilterManager, logger, this.throttleJWT);
    } else if (opaqueHeader) {
      this.middleware = createOpaqueMiddleware(opaqueHeader, this.bloomFilterManager, logger, this.throttleOpaque);
    } else {
      this.bloomFilterManager.destroy();
      throw new Error("claimsToCheck or opaqueHeader must be provided");
    }
  }

  /**
   * Returns the configured middleware.
   * @returns {RequestHandler} Middleware Express.
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
   */
  add(filterItem) {
    if (this.bloomFilterManager) {
      this.bloomFilterManager.add(filterItem);
    }
  }

  /**
   * Destroys the Bloom filter manager.
   */
  destroy() {
    if (this.bloomFilterManager) {
      this.bloomFilterManager.destroy();
      this.bloomFilterManager = null;
    }
  }
}

export const counters = { revokedJwtReplay, revokedOpaqueReplay };



