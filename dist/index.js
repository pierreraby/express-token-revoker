// @ts-check

import { BloomFilterManager } from "./Bloom-filter-manager.js";

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {Array<string>} claimsToCheck - List of claims to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @returns {Function} Express middleware.
 */
const createJWTMiddleware = (claimsToCheck , bloomFilterManager) => {
  return (req, res, next) => {
    try {
      for (const claim of claimsToCheck) {
        if (!req.token || !req.token[claim]) {
          throw new Error(`Missing claim: ${claim}`);
        }
        if (bloomFilterManager.filterHas(`${claim}-${req.token[claim]}`)) {
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
 * createOpaqueMiddleware
 * @param {string} header - The header to check.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @returns {Function} Express middleware.
 */
 const createOpaqueMiddleware = (header, bloomFilterManager) => {
  return (req, res, next) => {
    try {
      const normalizedHeader = header.toLowerCase();
      if (!req.headers[normalizedHeader]) {
        throw new Error(`Missing header: ${header}`);
      }
      
      let token;
      if (normalizedHeader === "authorization") {
        const parts = req.headers.authorization.split(" ");
        if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
          throw new Error(`Invalid authorization format`);
        }
        token = parts[1];
      } else {
        token = req.headers[normalizedHeader];
      }
      if (bloomFilterManager.filterHas(token)) {
        throw new Error(`Token is blacklisted`);
      }
      next();
    } catch (error) {
      res.status(401).json({ message: `Invalid token! ${error.message}` });
    }
  };
};


/**
 * Classe Revoker pour gérer le middleware et l'ajout au Bloom filter.
 */
export class Revoker {
  /**
   * @param {Object} config - Configuration des options.
   * @param {number} config.numItems - Nombre d'items à stocker.
   * @param {number} config.fpRate - Taux de faux positifs cible.
   * @param {number} config.rotateTime - Intervalle de rotation en ms.
   * @param {Array<string>} config.claimsToCheck - Claims à vérifier.
   * @param {string} config.opaqueHeader - Header à vérifierpour les tokens opaques.
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
   * Retourne le middleware configuré.
   * @returns {Function} Middleware Express.
   */
  getMiddleware() {
    return this.middleware;
  }

  /**
   * Ajoute un élément au Bloom filter.
   * @param {string} filterItem - L'élément à ajouter.
   */
  add(filterItem) {
    this.bloomFilterManager.filterAdd(filterItem);
  }
}



