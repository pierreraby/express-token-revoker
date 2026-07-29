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
  oneofs: true,
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const revokerProto: any = protoDescriptor.revoker;

export function createRevokerClientAsync(serverAddress: string) {
  const client = new revokerProto.RevokerAdmin(serverAddress, grpc.credentials.createInsecure());

  const promisifiedClient = {
    add: promisify(client.add).bind(client),
    has: promisify(client.has).bind(client),
    getMetrics: promisify(client.getMetrics).bind(client),
    resetAndRestore: promisify(client.resetAndRestore).bind(client),
    resetAndClearData: promisify(client.resetAndClearData).bind(client),
    ListRevokers: promisify(client.ListRevokers).bind(client),
    close: client.close.bind(client),
  };
  return promisifiedClient;
}

const clientAsync = createRevokerClientAsync('localhost:50051');

let revokerId = 'JWTrevoker';

const item = 'item1';

try {
  // Example of calling the ListRevokers method
  const listResponse = await clientAsync.ListRevokers({});
  console.log('List Response:', listResponse);

  // Example of calling the Add method
  const addResponse = await clientAsync.add({ revokerId, item });
  console.log('Add Response:', addResponse);

  // Example of calling the Has method
  const hasResponse1 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (1):', hasResponse1);

  // Example of calling the getMetrics method
  const metricsResponse = await clientAsync.getMetrics({ revokerId });
  const estimatedMetrics = metricsResponse.estimatedMetrics;
  const configuration = metricsResponse.configuration;
  console.log('Estimated Metrics:', estimatedMetrics);
  console.log('Configuration:', configuration);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Example of calling the ResetAndRestore method
  const resetRestoreResponse = await clientAsync.resetAndRestore({ revokerId });
  console.log('ResetAndRestore Response:', resetRestoreResponse);

  const hasResponse2 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (2):', hasResponse2);

  // Example of calling the ResetAndClearData method
  const resetClearDataResponse = await clientAsync.resetAndClearData({ revokerId });
  console.log('ResetAndClearData Response:', resetClearDataResponse);

  const hasResponse3 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (3):', hasResponse3);
} catch (error) {
  console.error('Error during gRPC call:', error);
}

revokerId = 'opaqueRevoker';

try {
  // Example of calling the ListRevokers method
  const listResponse = await clientAsync.ListRevokers({});
  console.log('List Response:', listResponse);

  // Example of calling the Add method
  const addResponse = await clientAsync.add({ revokerId, item });
  console.log('Add Response:', addResponse);

  // Example of calling the Has method
  const hasResponse1 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (1):', hasResponse1);

  // Example of calling the getMetrics method
  const metricsResponse = await clientAsync.getMetrics({ revokerId });
  const estimatedMetrics = metricsResponse.estimatedMetrics;
  const configuration = metricsResponse.configuration;
  console.log('Estimated Metrics:', estimatedMetrics);
  console.log('Configuration:', configuration);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Example of calling the ResetAndRestore method
  const resetRestoreResponse = await clientAsync.resetAndRestore({ revokerId });
  console.log('ResetAndRestore Response:', resetRestoreResponse);

  const hasResponse2 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (2):', hasResponse2);

  // Example of calling the ResetAndClearData method
  const resetClearDataResponse = await clientAsync.resetAndClearData({ revokerId });
  console.log('ResetAndClearData Response:', resetClearDataResponse);

  const hasResponse3 = await clientAsync.has({ revokerId, item });
  console.log('Has Response (3):', hasResponse3);
} catch (error) {
  console.error('Error during gRPC call:', error);
}

clientAsync.close();
