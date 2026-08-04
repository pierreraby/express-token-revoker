# @express-token-revoker/node

Distributed **participant node** for [express-token-revoker](../../README.md).

A node replicates revocation events from a coordinator
([`@express-token-revoker/server`](../server/README.md)) over the ordered
gRPC replication stream (`distributed.proto`), maintains its own local Bloom
filters (via `express-token-revoker` core with backup enabled), and serves
the Express revocation middleware from **local state only** — the request
path never talks to the coordinator.

> **Status: alpha.** Part of the distributed v1 slice. The auth/TLS decision
> for the coordinator link (PD-1) is still pending: keep the link on a
> trusted network / loopback until it lands.

## Guarantees

- **No false negatives**: a delta is never silently dropped. Any LSN gap,
  generation mismatch or `ResnapshotRequired` triggers a loud rebootstrap
  from the coordinator snapshot.
- **WAL-before-memory** on the node (inherited from core's `applyEntry`).
- **Coordinator down ⇒ the node keeps serving checks** from its local state
  (degraded mode); new revocations are refused — call the coordinator.
- Degraded self-rotation exists only as a safety timeout
  (`rotateTime × safetyFactor`); it marks the node `dirty` ⇒ full
  rebootstrap on reconnect.

## Quickstart

```ts
import { createRevokerNode } from '@express-token-revoker/node';

const node = await createRevokerNode({
  nodeId: 'node-a',
  coordinatorAddress: '127.0.0.1:50100',
  backupDir: '/var/lib/revoker/node-a',
  opaqueHeader: 'Authorization', // or claimsToCheck + payloadKey (JWT mode)
  filter: {
    numItems: 1_000_000,
    fpRate: 1e-9,
    rotateTime: 600_000, // expected coordinator rotateTime (ms)
  },
  // pollIntervalMs: 2000,  // degraded-mode poll cadence
  // safetyFactor: 2.5,     // degraded self-rotation timeout factor (>= 2)
});

app.use(node.getMiddleware()); // checks the LOCAL filter

// Revocations go to the coordinator — node.add() always throws.
```

## Public surface

| Member | Notes |
| ------ | ----- |
| `createRevokerNode(config, deps?)` | Factory: validates, bootstraps, starts the sync engine. |
| `getMiddleware()` | Core Express middleware (JWT or opaque), checks the local filter. |
| `has(item)` | Local revocation check. |
| `getMetrics()` | Core metrics passthrough. |
| `healthCheck()` | Core health + `sync` component (`connected`, `mode`, `lastAppliedLsn`, `dirty`). |
| `add(item)` | **Always throws** — revocations are coordinator-only (v1). |
| `shutdown()` / `destroy()` | Stop the sync engine, close the gRPC channel, shut down core. |

See `docs/distributed-architecture.md` (repo root) for the design.
