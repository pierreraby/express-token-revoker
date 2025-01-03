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
        throw new Error("Missing token");
      }

      for (const claim of claimsToCheck) {
        if (!reqWithToken.token || !reqWithToken.token[claim]) {
          throw new Error(`Missing claim: ${claim}`);
        }
        console.log(`${claim}-${reqWithToken.token[claim]}`);
        if (bloomFilterManager.filterHas(`${claim}-${reqWithToken.token[claim]}`)) {
          throw new Error(`Token ${claim} is blacklisted`);
        }
      }
      next();
    } catch (error) {
      res.status(401).json({ message: `Invalid token! ${error.message}` });
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
    /** @type {RequestWithToken} */
    const reqWithToken = req;
    try {
      const normalizedHeader = header.toLowerCase();
      if (!req.headers[normalizedHeader]) {
        throw new Error(`Missing header: ${header}`);
      }
      
      let token;
      if (normalizedHeader === "authorization") {
        if (!req.headers.authorization) {
          throw new Error(`Missing authorization header`);
        }
        const parts = req.headers.authorization.split(" ");
        if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
          throw new Error(`Invalid authorization format`);
        }
        token = parts[1];
      } else {
        token = req.headers[normalizedHeader];
      }
      if (typeof token === 'string' && bloomFilterManager.filterHas(token)) {
        throw new Error(`Token is blacklisted`);
      }
      next();
    } catch (error) {
      res.status(401).json({ message: `Invalid token! ${error.message}` });
    }
  };
};

/**
 * @typedef {import('express').RequestHandler} RequestHandler
 */

/**
 * Classe Revoker pour gérer le middleware et l'ajout au Bloom filter.
 */
export class Revoker {
  /**
   * @param {Object} config - Configuration options.
   * @param {number} config.numItems - Number of items to store.
   * @param {number} config.fpRate - Target false positive rate.
   * @param {number} config.rotateTime - Rotation interval in ms.
   * @param {Array<string>} config.claimsToCheck - Claims to check.
   * @param {string} config.opaqueHeader - Header to check for opaque tokens.
   * @throws {Error} If neither `claimsToCheck` nor `opaqueHeader` is provided.
   */
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
      throw new Error("claimsToCheck or opaqueHeader must be provided");
    }
  }

  /**
   * Returns the configured middleware.
   * @returns {RequestHandler} Middleware Express.
   */
  getMiddleware() {
    return this.middleware;
  }

  /**
   * Adds an item to the Bloom filter.
   * @param {string} filterItem - The item to add.
   */
  add(filterItem) {
    this.bloomFilterManager.filterAdd(filterItem);
  }
}



