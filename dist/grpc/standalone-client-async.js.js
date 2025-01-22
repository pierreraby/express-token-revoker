import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util'; // Importez l'utilitaire promisify

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

/**
 * Crée un client gRPC pour le service RevokerAdmin avec des méthodes promisifiées.
 * @param {string} serverAddress - L'adresse du serveur gRPC (par exemple, 'localhost:50051').
 * @returns {any} - Une instance du client gRPC avec des méthodes promisifiées.
 */
export function createRevokerClientAsync(serverAddress) {
  const client = new revokerProto.RevokerAdmin(serverAddress, grpc.credentials.createInsecure());

  // Promisifier chaque méthode que vous souhaitez utiliser avec async/await
  const promisifiedClient = {
    add: promisify(client.add).bind(client), // .bind(client) est important pour conserver le contexte 'this'
    has: promisify(client.has).bind(client),
    getMetrics: promisify(client.getMetrics).bind(client),
    resetAndRestore: promisify(client.resetAndRestore).bind(client),
    resetAndClearData: promisify(client.resetAndClearData).bind(client),
    destroy: promisify(client.destroy).bind(client),
  };
  return promisifiedClient;
}

// Exemple d'utilisation du client asynchrone
async function main() {
  const clientAsync = createRevokerClientAsync('localhost:50051');

  try {
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
}

main();