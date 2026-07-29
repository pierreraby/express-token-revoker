import Joi from 'joi';

// id is interpolated into backup file names (current-<id>.blob, ...) — restrict
// the charset to prevent path traversal and keep file names portable.
const idSchema = Joi.string()
  .pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .required()
  .description(
    'Unique identifier for the revoker and bloom filter (letters, digits, "_" or "-", max 64 chars)'
  );

const revokerInputSchema = Joi.object({
  id: idSchema,
  logger: Joi.object({
    info: Joi.function().required(),
    error: Joi.function().required(),
    warn: Joi.function().required(),
    debug: Joi.function().required(),
  })
    .unknown(true)
    .required()
    .description('Generic logger object'),
  grpcEnabled: Joi.boolean().strict().description('Enable gRPC server'),
  grpcPort: Joi.number()
    .strict()
    .port()
    .when('grpcEnabled', { is: true, then: Joi.required() })
    .when('grpcEnabled', { not: Joi.exist(), then: Joi.forbidden() })
    .when('grpcEnabled', { is: false, then: Joi.forbidden() })
    .description('Port for gRPC server'),
  grpcHost: Joi.string()
    .hostname()
    .when('grpcEnabled', { not: Joi.exist(), then: Joi.forbidden() })
    .when('grpcEnabled', { is: false, then: Joi.forbidden() })
    .description(
      'Host to bind the gRPC server to. Defaults to 127.0.0.1 (loopback only). The admin service is unauthenticated: never expose it remotely without TLS.'
    ),
  grpcAllowInsecureRemote: Joi.boolean()
    .strict()
    .when('grpcEnabled', { not: Joi.exist(), then: Joi.forbidden() })
    .when('grpcEnabled', { is: false, then: Joi.forbidden() })
    .description(
      'Allow binding the gRPC admin service without TLS on a non-loopback host. Strongly discouraged.'
    ),
  claimsToCheck: Joi.array()
    .min(1)
    .items(Joi.string())
    .when('opaqueHeader', { is: Joi.exist(), then: Joi.forbidden() })
    .required()
    .description('List of claims to check in the token'),
  payloadKey: Joi.string()
    .when('opaqueHeader', { is: Joi.exist(), then: Joi.forbidden() })
    .when('claimsToCheck', { is: Joi.exist(), then: Joi.required() })
    .description('Key to get jwt payload from request'),
  opaqueHeader: Joi.string().description('Header to check opaque token'),
  filter: Joi.object().required().description('Bloom filter configuration'),
});

const filterInputSchema = Joi.object({
  // revalidate id and logger schema to keep the bloom filter validation independent
  id: idSchema,
  logger: Joi.object({
    info: Joi.function().required(),
    error: Joi.function().required(),
    warn: Joi.function().required(),
    debug: Joi.function().required(),
  })
    .unknown(true)
    .required()
    .description('Generic logger object'),
  numItems: Joi.number()
    .positive()
    .integer()
    .min(1)
    .max(100_000_000)
    .required()
    .description('Number of items to store in the filter'),
  fpRate: Joi.number()
    .positive()
    .less(1)
    .required()
    .description('False positive rate for the filter — exclusive: (0, 1)'),
  rotateTime: Joi.number()
    .positive()
    .integer()
    .required()
    .description('Time to rotate the filter in milliseconds'),
  backup: Joi.boolean().strict().description('Enable backup filter'),
  backupDir: Joi.string()
    .when('backup', { not: Joi.exist(), then: Joi.forbidden() })
    .when('backup', { is: false, then: Joi.forbidden() })
    .description('Directory to store the backup filter'),
  backupRatioTime: Joi.number()
    .positive()
    .integer()
    .when('backup', { not: Joi.exist(), then: Joi.forbidden() })
    .when('backup', { is: false, then: Joi.forbidden() })
    .description('Ratio of the rotation time for backups'),
  bufferEnabled: Joi.boolean()
    .strict()
    .when('backup', { not: Joi.exist(), then: Joi.forbidden() })
    .when('backup', { is: false, then: Joi.forbidden() })
    .description('Enable buffer for items added tothe filter'),
  bufferMaxSize: Joi.number()
    .positive()
    .integer()
    .min(100)
    .when('bufferEnabled', { not: Joi.exist(), then: Joi.forbidden() })
    .when('bufferEnabled', { is: false, then: Joi.forbidden() })
    .description(
      'Maximum number of tokens to hold in the write buffer before rejecting new additions'
    ),
});

export { revokerInputSchema, filterInputSchema };
