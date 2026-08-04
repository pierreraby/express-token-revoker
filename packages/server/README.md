# @express-token-revoker/server

Distributed **coordinator** for [express-token-revoker](../core).

> Status: **alpha** — internal package (`private: true`), not published yet.

## Role

The coordinator is the single canonical writer of a distributed revocation
cluster:

- owns the **canonical write-ahead log** (one append-only file per filter
  generation, every event carries a monotonic LSN),
- receives admin revocations (`Add`) with canonical-first ordering — the
  entry is appended to the WAL **before** it is applied to the in-memory
  Bloom filter,
- **owns the rotation schedule** and broadcasts `Rotate` events so every
  participant node rotates on the same window boundary,
- streams ordered deltas to participant nodes (`Subscribe`, server-streaming,
  with `PollDeltas` as the degraded-mode fallback),
- serves consistent **snapshots** (`GetSnapshot`) for node bootstrap
  (snapshot + canonical-tail replay ⇒ exact state).

Participant nodes live in `@express-token-revoker/node` (Phase 4). The
wire protocol is defined by `distributed.proto`, shipped by
`express-token-revoker` (core stays distribution-agnostic).

## Usage (preview)

```ts
import { createCoordinator } from '@express-token-revoker/server';

const coordinator = await createCoordinator({
  id: 'main',
  port: 50100,
  backupDir: '/var/lib/revoker/backup',
  opaqueHeader: 'authorization',
  filter: {
    numItems: 1_000_000,
    fpRate: 1e-9,
    rotateTime: 15 * 60 * 1000, // = JWT TTL
    backupRatioTime: 4,
  },
});

// Admin revocation (canonical-first):
const { success, lsn } = coordinator.add('jti-abc123');

// ... later
await coordinator.shutdown();
```

## Security posture (v1)

The coordinator↔node gRPC link is authenticated (PD-1, decided and
implemented): `auth.mode` defaults to `shared-secret` (one-way TLS + shared
secret ≥ 16 chars in gRPC metadata); `mtls` adds mutual TLS; `insecure` is
development-only — it must be opted into explicitly, logs a loud warning at
startup and refuses non-loopback binds. If the `auth` block is completely
omitted from the config, the coordinator runs the legacy insecure
loopback-only posture with a loud startup warning — it does NOT default to
shared-secret, which is the default only when an `auth` block is present.
`scripts/gen-certs.mjs` generates the
TLS material. See `docs/distributed-architecture.md` (repo root) for the
auth table and requirements per mode.
