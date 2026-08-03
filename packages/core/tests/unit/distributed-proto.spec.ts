import { describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTO_PATH = path.join(__dirname, '../../src/grpc/protos/distributed.proto');

// Same loader options as std-server.ts / std-client.ts (see Phase 2 of the
// distributed plan): every consumer of this proto must use identical options
// so that message shapes line up across packages.
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const COORDINATOR_KEY = 'revoker.distributed.RevokerCoordinator';
const EXPECTED_RPCS = [
  'Add',
  'Has',
  'GetMetrics',
  'GetSnapshot',
  'Subscribe',
  'PollDeltas',
  'ListNodes',
] as const;

// In the raw PackageDefinition, a service entry is directly the map of its
// RPC methods (each with path / requestStream / responseStream).
const coordinatorService: any = packageDefinition[COORDINATOR_KEY];

/**
 * Returns the protobuf DescriptorProto of a message loaded via
 * grpc.loadPackageDefinition (fields in `.field[]`, oneofs in `.oneofDecl[]`).
 */
const messageType = (qualifiedName: string): any => {
  const descriptor: any = grpc.loadPackageDefinition(packageDefinition);
  const message = descriptor.revoker.distributed[qualifiedName];
  expect(message?.format).toContain('DescriptorProto');
  return message.type;
};

describe('distributed.proto (wire protocol smoke test)', () => {
  it('is self-contained: no cross-proto imports', () => {
    const content = fs.readFileSync(PROTO_PATH, 'utf8');
    expect(content).not.toMatch(/^\s*import\s/m);
    expect(content).toContain('package revoker.distributed;');
    expect(content).toContain('syntax = "proto3";');
  });

  it('exposes the RevokerCoordinator service in the revoker.distributed package', () => {
    expect(coordinatorService).toBeDefined();
    // Loaded through grpc-js, the service becomes a client constructor whose
    // `.service` property mirrors the raw method map (same shape the
    // coordinator server will register in Phase 3).
    const loaded: any = grpc.loadPackageDefinition(packageDefinition);
    const clientCtor = loaded.revoker.distributed.RevokerCoordinator;
    expect(typeof clientCtor).toBe('function');
    expect(Object.keys(clientCtor.service).sort()).toEqual([...EXPECTED_RPCS].sort());
  });

  it('declares exactly the 7 RPCs from the plan', () => {
    const rpcNames = Object.keys(coordinatorService).sort();
    expect(rpcNames).toEqual([...EXPECTED_RPCS].sort());
  });

  it('Subscribe is server-streaming, all other RPCs are unary', () => {
    expect(coordinatorService.Subscribe.requestStream).toBe(false);
    expect(coordinatorService.Subscribe.responseStream).toBe(true);

    for (const rpcName of EXPECTED_RPCS) {
      if (rpcName === 'Subscribe') {
        continue;
      }
      expect(coordinatorService[rpcName].requestStream, `${rpcName} requestStream`).toBe(false);
      expect(coordinatorService[rpcName].responseStream, `${rpcName} responseStream`).toBe(false);
    }
  });

  it('exposes RPC paths under /revoker.distributed.RevokerCoordinator/', () => {
    for (const rpcName of EXPECTED_RPCS) {
      expect(coordinatorService[rpcName].path).toBe(
        `/revoker.distributed.RevokerCoordinator/${rpcName}`
      );
    }
  });

  it('StreamEvent declares exactly one oneof "event" with the 4 members from the plan', () => {
    const streamEvent = messageType('StreamEvent');

    expect(streamEvent.oneofDecl).toHaveLength(1);
    expect(streamEvent.oneofDecl[0].name).toBe('event');

    const oneofFields = streamEvent.field
      .filter((field: any) => field.oneofIndex === 0)
      .map((field: any) => field.name)
      .sort();
    expect(oneofFields).toEqual(['entry', 'keepalive', 'resnapshot', 'rotate']);
  });

  it('StreamEvent field tags match the proto numbering', () => {
    const streamEvent = messageType('StreamEvent');
    const tags = Object.fromEntries(streamEvent.field.map((f: any) => [f.name, f.number]));
    expect(tags.entry).toBe(1);
    expect(tags.rotate).toBe(2);
    expect(tags.keepalive).toBe(3);
    expect(tags.resnapshot).toBe(4);
  });

  it('WalEntry carries lsn/generation/item with the planned tags', () => {
    const walEntry = messageType('WalEntry');
    const tags = Object.fromEntries(walEntry.field.map((f: any) => [f.name, f.number]));
    expect(tags).toEqual({ lsn: 1, generation: 2, item: 3 });
  });

  it('GetSnapshotResponse carries blobs, consistency point and geometry with the planned tags', () => {
    const snapshot = messageType('GetSnapshotResponse');
    const tags = Object.fromEntries(snapshot.field.map((f: any) => [f.name, f.number]));
    expect(tags).toEqual({
      currentBlob: 1,
      previousBlob: 2,
      generation: 3,
      lastBackupLsn: 4,
      numItems: 5,
      fpRate: 6,
      k: 7,
      rotateTime: 8,
    });
  });

  it('DistGetMetricsResponse mirrors core metrics shape plus cluster state', () => {
    const metrics = messageType('DistGetMetricsResponse');
    const tags = Object.fromEntries(metrics.field.map((f: any) => [f.name, f.number]));
    expect(tags).toEqual({
      currentCount: 1,
      previousCount: 2,
      currentFpRate: 3,
      previousFpRate: 4,
      numItems: 5,
      fpRate: 6,
      rotateTime: 7,
      generation: 8,
      lastLsn: 9,
    });
  });
});
