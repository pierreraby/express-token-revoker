import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import type { GenericLogger } from './types.js';
import type { BloomFilterManager } from './Bloom-filter-manager.js';
import { ValidationError } from './errors.js';
import { logOrThrottle } from './throttle.js';

export interface JWTPayload {
  /** Issuer claim. */
  iss?: string;
  /** Subject claim. */
  sub?: string;
  /** Audience claim. */
  aud?: string;
  /** Expiration time claim (seconds since epoch). */
  exp?: number;
  /** Not before claim (seconds since epoch). */
  nbf?: number;
  /** Issued at claim (seconds since epoch). */
  iat?: number;
  /** JWT ID claim. */
  jti?: string;
  /** Allows adding additional claims. */
  [anyOtherClaim: string]: any;
}

/**
 * Returns a short, non-reversible fingerprint of a token for logging.
 * Raw tokens are bearer secrets and must never appear in logs.
 */
const redactToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 8);

/**
 * Middleware factory to check claims with the Bloom filter.
 * @param claimsToCheck - List of claims to check.
 * @param payloadKey - The key to get the token payload from the request.
 * @param bloomFilterManager - Instance of the Bloom filter manager.
 * @param logger - Any logger implementing the basic logging methods
 * @param throttleJWT - Throttle function.
 * @returns Middleware Express.
 */
export const createJWTMiddleware = (
  claimsToCheck: string[],
  payloadKey: string,
  bloomFilterManager: BloomFilterManager,
  logger: GenericLogger,
  throttleJWT: (message: string) => void
): RequestHandler => {
  /**
   * Validates the presence of the JWT payload.
   * @param payload - The JWT payload to validate.
   * @returns True if token is valid, throws otherwise
   * @throws If the payload is missing.
   */
  const validatePayload = (payload: JWTPayload | undefined): payload is JWTPayload => {
    if (!payload) {
      throw new ValidationError('Missing JWT payload in request');
    }
    return true;
  };

  /**
   * Validates a specific claim in the JWT payload.
   * @param payload - The JWT payload to validate.
   * @param claim - The claim to validate.
   * @throws If the claim is missing or blacklisted.
   */
  const validateClaim = (payload: JWTPayload, claim: string): boolean => {
    if (payload[claim] === undefined || payload[claim] === null) {
      throw new ValidationError(`Missing ${claim} claim in JWT Payload`);
    }

    if (bloomFilterManager.has(`${claim}-${payload[claim]}`)) {
      // Never log the claim value — it may be sensitive.
      logOrThrottle(`Token with claim '${claim}' is blacklisted`, throttleJWT, logger, false);
      return false;
    }
    return true;
  };

  /**
   * Validates all specified claims in the JWT token.
   * @param payload - The JWT payload to validate.
   * @param claims - The claims to validate.
   */
  const validateAllClaims = (payload: JWTPayload, claims: string[]): boolean => {
    return claims.every((claim) => validateClaim(payload, claim));
  };

  /**
   * Express middleware to validate JWT tokens against a Bloom filter.
   */
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const decodedPayload = (req as unknown as Record<string, JWTPayload | undefined>)[payloadKey];

      if (validatePayload(decodedPayload) && validateAllClaims(decodedPayload, claimsToCheck)) {
        next();
      } else {
        res.status(401).json({
          error: 'invalid_token',
          message: 'Invalid token!',
        });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        logger.warn(`Validation error: ${error.message}`);
        res.status(400).json({
          error: 'validation_error',
          message: error.message,
        });
      } else {
        logger.error(`Unexpected error during JWT validation: ${(error as Error).message}`);
        res.status(500).json({
          error: 'internal_error',
          message: 'An unexpected error occurred',
        });
      }
    }
  };
};

/**
 * Middleware factory to check opaque token with the Bloom filter.
 * @param header - The header to check.
 * @param bloomFilterManager - Instance of the Bloom filter manager.
 * @param logger - Any logger implementing the basic logging methods
 * @param throttleOpaque - Throttle function.
 * @returns Middleware Express.
 */
export const createOpaqueMiddleware = (
  header: string,
  bloomFilterManager: BloomFilterManager,
  logger: GenericLogger,
  throttleOpaque: (message: string) => void
): RequestHandler => {
  /**
   * Extracts the token from the request headers.
   * @param req - Express request object.
   * @param normalizedHeader - The normalized header name.
   * @returns The extracted token.
   * @throws If the header is missing or invalid.
   */
  const extractToken = (req: Request, normalizedHeader: string): string => {
    const headerValue = req.headers[normalizedHeader];

    if (!headerValue) {
      throw new ValidationError(`Missing header: ${normalizedHeader}`);
    }

    if (normalizedHeader === 'authorization') {
      // Ensure headerValue is a string
      const authHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      const [type, token] = authHeader.split(' ');

      if (!token || type.toLowerCase() !== 'bearer') {
        throw new ValidationError('Invalid authorization header format. Expected "Bearer <token>"');
      }
      return token;
    }

    // For other headers, take the first value if it's an array
    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  };

  /**
   * Validates the token against the Bloom filter.
   * @param token - The token to validate.
   * @param bloomFilterManager - Instance of the Bloom filter manager.
   * @throws If the token is blacklisted.
   */
  const validateToken = (token: string, bloomFilterManager: BloomFilterManager): boolean => {
    if (token && bloomFilterManager.has(token)) {
      logOrThrottle(
        `Token (sha256:${redactToken(token)}) is blacklisted`,
        throttleOpaque,
        logger,
        false
      );
      return false;
    }
    return true;
  };

  /**
   * Express middleware to validate Opaques tokens/ API KEYS against a Bloom filter.
   */
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const normalizedHeader = header.toLowerCase();
      const token = extractToken(req, normalizedHeader);
      if (validateToken(token, bloomFilterManager)) {
        next();
      } else {
        res.status(401).json({
          error: 'invalid_token',
          message: `Invalid token!`,
        });
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        logger.warn(`Validation error: ${error.message}`);
        res.status(400).json({
          error: 'validation_error',
          message: error.message,
        });
      } else {
        logger.error(
          `Unexpected error during opaque token validation: ${(error as Error).message}`
        );
        res.status(500).json({
          error: 'internal_error',
          message: 'An unexpected error occurred',
        });
      }
    }
  };
};
