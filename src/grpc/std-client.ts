import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
// The protoLoader does not generate types for the service
const revokerProto: any = protoDescriptor.revoker;

/**
 * Creates a callback-style gRPC client for the RevokerAdmin service.
 *
 * Importing this module has no side effects. For a promisified client, see
 * `std-client-async.ts`; for a runnable demo, see `examples/standalone/`.
 *
 * @param serverAddress - The gRPC server address (e.g. 'localhost:50051').
 * @returns A gRPC client instance for the RevokerAdmin service.
 */
export function createRevokerClient(serverAddress: string): any {
  return new revokerProto.RevokerAdmin(serverAddress, grpc.credentials.createInsecure());
}
