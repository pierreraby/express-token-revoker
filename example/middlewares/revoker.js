
/* @ts-check */
import { Revoker } from '../../dist/index.js';

const JWTconfig = { // this config uses ~21MB of memory
  numItems: 1000000, // 1 million items
  fpRate: 0.000001, // one in a million
  rotateTime: 1800000, // 30 minutes
  claimsToCheck: ["jti", "fam", "sub"] // adding claims to check, return a JWT check middleware
};

const JWTrevoker = new Revoker(JWTconfig);
const JWTfilter = JWTrevoker.getMiddleware();

const opaqueConfig = {
  numItems: 1000000,
  fpRate: 0.000001,
  rotateTime: 1800000,
  opaqueHeader: "Authorization" // adding header where to check opaque token, maybe 'X-Auth-Token', etc
};

const opaqueRevoker = new Revoker(opaqueConfig);
const opaqueFilter = opaqueRevoker.getMiddleware();

const opaqueConfigCustom = { // this config uses ~30MB of memory
  numItems: 1000000,
  fpRate: 0.000000001, // one in a billion
  rotateTime: 1800000,
  opaqueHeader: "X-Auth-Token" // adding header where to check opaque token.
};

const opaqueRevokerCustom = new Revoker(opaqueConfigCustom);
const opaqueFilterCustom = opaqueRevokerCustom.getMiddleware();

export { JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter, opaqueRevokerCustom, opaqueFilterCustom };