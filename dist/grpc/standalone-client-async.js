import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.join(__dirname, './protos/revoker.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const revokerProto = protoDescriptor.revoker;

export function createRevokerClientAsync(serverAddress) {
  const client = new revokerProto.RevokerAdmin(serverAddress, grpc.credentials.createInsecure());

  const promisifiedClient = {
    add: promisify(client.add).bind(client),
    has: promisify(client.has).bind(client),
    getMetrics: promisify(client.getMetrics).bind(client),
    resetAndRestore: promisify(client.resetAndRestore).bind(client),
    resetAndClearData: promisify(client.resetAndClearData).bind(client),
    destroy: promisify(client.destroy).bind(client),
    ListRevokers: promisify(client.ListRevokers).bind(client)
  };
  return promisifiedClient;
}

const clientAsync = createRevokerClientAsync('localhost:50051');

try {
  // Exemple d'appel à la méthode ListRevokerInstances
  const listResponse = await clientAsync.ListRevokers({});
  console.log('List Response:', listResponse);

  // Exemple d'appel à la méthode Add
  const addResponse = await clientAsync.add({ revokerId: 'JWTrevoker', filterItem: 'yourFilterItem' });
  console.log('Add Response:', addResponse);

  // Exemple d'appel à la méthode Has
  const hasResponse1 = await clientAsync.has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' });
  console.log('Has Response (1):', hasResponse1);

  // Exemple d'appel à la méthode getMetrics
  const metricsResponse = await clientAsync.getMetrics({ revokerId: 'JWTrevoker' });
  const estimatedMetrics = JSON.parse(metricsResponse.metrics.estimatedMetrics);
  const configuration = JSON.parse(metricsResponse.metrics.configuration);
  console.log('Estimated Metrics:', estimatedMetrics);
  console.log('Configuration:', configuration);

  // Exemple d'appel à la méthode ResetAndRestore
  const resetRestoreResponse = await clientAsync.resetAndRestore({ revokerId: 'JWTrevoker' });
  console.log('ResetAndRestore Response:', resetRestoreResponse);

  const hasResponse2 = await clientAsync.has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' });
  console.log('Has Response (2):', hasResponse2);

  // Exemple d'appel à la méthode ResetAndClearData
  const resetClearDataResponse = await clientAsync.resetAndClearData({ revokerId: 'JWTrevoker' });
  console.log('ResetAndClearData Response:', resetClearDataResponse);

  const hasResponse3 = await clientAsync.has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' });
  console.log('Has Response (3):', hasResponse3);

  // Exemple d'appel à la méthode Destroy
  const destroyResponse = await clientAsync.destroy({ revokerId: 'JWTrevoker' });
  console.log('Destroy Response:', destroyResponse);

} catch (error) {
  console.error('Error during gRPC call:', error);
}