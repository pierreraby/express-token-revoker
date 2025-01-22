import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';

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
 * Crée un client gRPC pour le service RevokerAdmin.
 * @param {string} serverAddress - L'adresse du serveur gRPC (par exemple, 'localhost:50051').
 * @returns {any} - Une instance du client gRPC.
 */
export function createRevokerClient(serverAddress) {
  const client = new revokerProto.RevokerAdmin(serverAddress, grpc.credentials.createInsecure());
  return client;
}

// Exemple d'utilisation du client
const client = createRevokerClient('localhost:50051');

// Exemple d'appel à la méthode ListRevokers
client.ListRevokers({}, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('List Response:', response);
  }
});

// Exemple d'appel à la méthode Add
client.Add({ revokerId: 'JWTrevoker', filterItem: 'yourFilterItem' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Add Response:', response);
  }
});

// Exemple d'appel à la méthode Has
client.Has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Has Response:', response);
  }
});

// Exemple d'appel à la méthode getMetrics
client.GetMetrics({ revokerId: 'JWTrevoker' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    const estimatedMetrics = response.estimatedMetrics;
    const configuration = response.configuration;
    
    console.log('Estimated Metrics:', estimatedMetrics);
    console.log('Configuration:', configuration);
  }
});

// Exemple d'appel à la méthode ResetAndRestore
client.ResetAndRestore({ revokerId: 'JWTrevoker' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('ResetAndRestore Response:', response);
  }
});



client.Has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Has Response:', response);
  }
});


// Exemple d'appel à la méthode ResetAndClearData
client.ResetAndClearData({ revokerId: 'JWTrevoker' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('ResetAndClearData Response:', response);
  }
});

// wait 1 second
await new Promise((resolve) => setTimeout(resolve, 1000));

client.Has({ revokerId: 'JWTrevoker', item: 'yourFilterItem' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Has Response:', response);
  }
});

// Exemple d'appel à la méthode Destroy
client.Destroy({ revokerId: 'JWTrevoker' }, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('Destroy Response:', response);
  }
});

// Exemple d'appel à la méthode ListRevokers
client.ListRevokers({}, (err, response) => {
  if (err) {
    console.error('Error:', err);
  } else {
    console.log('List Response:', response);
  }
});