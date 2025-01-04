// @ts-check

import { BloomFilterManager } from "./Bloom-filter-manager.js";

/**
 * @typedef {import('express').Request} Request
 * @typedef {Request & { token?: any }} RequestWithToken
 */

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {Array<string>} claimsToCheck - List of claims to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @returns {import('express').RequestHandler} Middleware Express.
*/
const createJWTMiddleware = (claimsToCheck , bloomFilterManager) => {
  return (req, res, next) => {
      /** @type {RequestWithToken} */
      const reqWithToken = req;

    try {
      if (!reqWithToken.token) {
        throw new Error("Missing jwt token");
      }

      for (const claim of claimsToCheck) {
        if (!reqWithToken.token[claim]) {
          throw new Error(`Missing ${claim} claim in JWT token`);
        }

        if (bloomFilterManager.has(`${claim}-${reqWithToken.token[claim]}`)) {
          throw new Error(`Token ${claim} is blacklisted`);
        }
      }
      next();
    } catch (error) {
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
 * Middleware factory to check opaque token with the Bloom filter.
 * @param {string} header - The header to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
 const createOpaqueMiddleware = (header, bloomFilterManager) => {
  return (req, res, next) => {
    try {
      const normalizedHeader = header.toLowerCase();
      if (!req.headers || !req.headers[normalizedHeader]) {
        throw new Error(`Missing header: ${header}`);
      }
      
      let token;
      if (normalizedHeader === "authorization") {
        // @ts-ignore
        const parts = req.headers.authorization.split(" ");
        if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
          throw new Error('Invalid authorization header');
        }
        token = parts[1];
      } else {
        token = req.headers[normalizedHeader];
      }
      if (typeof token === 'string' && bloomFilterManager.has(token)) {
        throw new Error(`Token is blacklisted`);
      }
      next();
    } catch (error) {
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
*
 * @typedef {Object} ConfigBase
 * @property {number} numItems - Number of items to store in the Bloom filter.
 * @property {number} fpRate - Target false positive rate for the Bloom filter.
 * @property {number} rotateTime - Rotation interval in milliseconds.
*
 * @typedef {ConfigBase & { claimsToCheck: Array<string>, opaqueHeader?: never }} JWTConfig
 * @typedef {ConfigBase & { opaqueHeader: string, claimsToCheck?: never }} OpaqueConfig
 * @typedef {JWTConfig | OpaqueConfig} Config
 */

/**
 * Revoker class to manage middleware and adding items to the Bloom filter.
 */
export class Revoker {
/**
   * @param {Config} config - Configuration options.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
  /** @type {BloomFilterManager | null} */
  bloomFilterManager = null;

  /** @type {RequestHandler | null} */
  middleware = null;

  constructor(config) {
    const { numItems, fpRate, rotateTime, claimsToCheck, opaqueHeader } = config;
    this.bloomFilterManager = new BloomFilterManager({
      numItems,
      fpRate,
      rotateTime, // 30 minutes
    });

    if (claimsToCheck) {
      this.middleware = createJWTMiddleware(claimsToCheck , this.bloomFilterManager);
    } else if (opaqueHeader) {
      this.middleware = createOpaqueMiddleware(opaqueHeader, this.bloomFilterManager);
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



