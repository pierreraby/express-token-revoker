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

import { BloomFilterManager } from "./Bloom-filter-manager.js";
import { ValidationError } from './errors.js';
import { logOrThrottle } from './throttle.js';



/**
 * Middleware factory to check claims with the Bloom filter.
 * @param {string[]} claimsToCheck - List of claims to check.
 * @param {string} payloadKey - The key to get the token payload from the request.
 * @param {BloomFilterManager} bloomFilterManager - Instance of the Bloom filter manager.
 * @param {GenericLogger} logger - Any logger implementing the basic logging methods
 * @param {Function} throttleJWT - Throttle function.
 * @returns {import('express').RequestHandler} Middleware Express.
 */
export const createJWTMiddleware = (claimsToCheck, payloadKey, bloomFilterManager, logger, throttleJWT) => {

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
          message: "Invalid token!",
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
export const createOpaqueMiddleware = (header, bloomFilterManager, logger, throttleOpaque) => {

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