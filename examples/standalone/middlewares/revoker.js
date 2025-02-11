
// @ts-check 
import { createRevoker } from '#dist/index.js';
import logger from '#logger';

const JWTconfig = { // this config uses ~21MB of memory
  // Core configuration
  id: "JWTrevoker",
  logger,
  // grpcEnabled: true,
  // grpcPort: 50051,
  // Token validation configuration
  claimsToCheck: ["jti", "fam", "sub"], // adding claims to check, return a JWT check middleware
  payloadKey: "token", // key to get token payload from request
  filter: {
    // Bloom Filter configuration
    numItems: 1000000, // 1 million items
    fpRate: 0.000001, // one in a million
    rotateTime: 1 * 60000, // 10 minutes
    backup: true,
    backupRatioTime: 2 // 5 minutes (rotateTime / backupRatioTime)
  }
};



const opaqueConfig = {
  id: "opaqueRevoker",
  opaqueHeader: "Authorization", // adding header where to check opaque token, maybe 'X-Auth-Token', etc
  logger,
  grpcEnabled: true,
  grpcPort: 50051,
  filter: {
    numItems: 1000000,
    fpRate: 0.000001,
    rotateTime: 30 * 60000, // 30 minutes
    backup: true,
    backupRatioTime: 3 // 10 minutes (rotateTime / backupRatioTime)
  }
};

const opaqueConfigCustom = { // this config uses ~30MB of memory
  id: "opaqueRevokerCustom",
  opaqueHeader: "X-Auth-Token", // adding header where to check opaque token. (x-auth-api, etc)
  logger,
  filter: {
    numItems: 1000000,
    fpRate: 0.000001,
    rotateTime: 30 * 60000, // 30 minutes
    backup: true,
    backupRatioTime: 3 // 10 minutes (rotateTime / backupRatioTime)
  }
};

let JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter, opaqueRevokerCustom, opaqueFilterCustom;

try {
  JWTrevoker = await createRevoker(JWTconfig);
  JWTfilter = JWTrevoker.getMiddleware();
  
  opaqueRevoker = await createRevoker(opaqueConfig);
  opaqueFilter = opaqueRevoker.getMiddleware();
  
  opaqueRevokerCustom = await createRevoker(opaqueConfigCustom);
  opaqueFilterCustom = opaqueRevokerCustom.getMiddleware();
} catch (error) {
  logger.error(`Error creating revoker: ${error.message}`);
}


export { JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter, opaqueRevokerCustom, opaqueFilterCustom };