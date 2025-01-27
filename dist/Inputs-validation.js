import Joi from 'joi';

const revokerInputSchema = Joi.object({
  id: Joi.string()
    .required()
    .description('Unique identifier for the revoker an bloom filter'),
  logger: Joi.object({
    info: Joi.function().required(),
    error: Joi.function().required(),
    warn: Joi.function().required(),
    debug: Joi.function().required(),
    })
    .unknown(true)
    .required()
    .description('Generice logger object'),
  grpcEnabled: Joi.boolean()
    .strict()
    .description('Enable gRPC server'),
  grpcPort: Joi.string()
    .when('grpcEnabled', { is: true, then: Joi.required() })
    .when('grpcEnabled', { not: Joi.exist(), then: Joi.forbidden() })
    .when('grpcEnabled', { is: false, then: Joi.forbidden() })
    .description('Port for gRPC server'),
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
  opaqueHeader: Joi.string()
    .description('Header to check opaque token'),
  filter: Joi.object()
    .required()
    .description('Bloom filter configuration'),
});

const filterInputSchema = Joi.object({
  // revalidate id and logger schema to keep the bloom filter validation independent
  id: Joi.string() 
    .required()
    .description('Unique identifier for the revoker an bloom filter'),
  logger: Joi.object({
    info: Joi.function().required(),
    error: Joi.function().required(),
    warn: Joi.function().required(),
    debug: Joi.function().required(),
    })
    .unknown(true)
    .required()
    .description('Generice logger object'),
  numItems: Joi.number()
    .positive()
    .integer()
    .min(1)
    .required()
    .description('Number of items to store in the filter'),
  fpRate: Joi.number()
    .positive()
    .max(1)
    .required()
    .description('False positive rate for the filter'),
  rotateTime: Joi.number()
    .positive()
    .integer()
    .required()
    .description('Time to rotate the filter in milliseconds'),  
  backup: Joi.boolean()
    .strict()
    .description('Enable backup filter'),
  backupTime: Joi.number()
    .positive()
    .integer()
    .when('backup', { not: Joi.exist(), then: Joi.forbidden() })
    .when('backup', { is: false, then: Joi.forbidden() })
    .less(Joi.ref('rotateTime'))
    .description('Time to rotate the backup filter in milliseconds'),
});  


export { revokerInputSchema, filterInputSchema };