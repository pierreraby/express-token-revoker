// Copies the gRPC proto files into the build output (tsc only emits .ts → .js).
// Written as a Node script so `npm run build` also works on Windows.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('build/grpc/protos', { recursive: true });
cpSync('src/grpc/protos', 'build/grpc/protos', { recursive: true });
console.log('Copied proto files to build/grpc/protos');
