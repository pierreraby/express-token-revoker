
// @ts-check 
import { Revoker } from '#dist/index.js';
import logger from '#logger';

const JWTconfig = { // this config uses ~21MB of memory
  // Core configuration
  id: "JWTrevoker",
  logger,
  grpcEnabled: true,
  grpcPort: "50051",
  // Token validation configuration
  claimsToCheck: ["jti", "fam", "sub"], // adding claims to check, return a JWT check middleware
  payloadKey: "token", // key to get token payload from request
  filter: {
    // Bloom Filter configuration
    numItems: 1000000, // 1 million items
    fpRate: 0.000001, // one in a million
    rotateTime: 10 * 60000, // 10 minutes
    backup: true,
    backupTime: 5 * 60000, // 5 minutes
  }
};

const JWTrevoker = new Revoker(JWTconfig);
const JWTfilter = JWTrevoker.getMiddleware();

const opaqueConfig = {
  id: "opaqueRevoker",
  opaqueHeader: "Authorization", // adding header where to check opaque token, maybe 'X-Auth-Token', etc
  logger,
  grpcEnabled: true,
  grpcPort: "50051",
  filter: {
    numItems: 1000000,
    fpRate: 0.000001,
    rotateTime: 30 * 60000, // 30 minutes
    backup: true,
    backupTime: 5 * 60000, // 5 minute
  }
};

const opaqueRevoker = new Revoker(opaqueConfig);
const opaqueFilter = opaqueRevoker.getMiddleware();

const opaqueConfigCustom = { // this config uses ~30MB of memory
  id: "opaqueRevokerCustom",
  opaqueHeader: "X-Auth-Token", // adding header where to check opaque token. (x-auth-api, etc)
  logger,
  filter: {
    numItems: 1000000,
    fpRate: 0.000001,
    rotateTime: 30 * 60000, // 30 minutes
    backup: true,
    backupTime: 5 * 60000, // 5 minute
  }
};

const opaqueRevokerCustom = new Revoker(opaqueConfigCustom);
const opaqueFilterCustom = opaqueRevokerCustom.getMiddleware();

export { JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter, opaqueRevokerCustom, opaqueFilterCustom };