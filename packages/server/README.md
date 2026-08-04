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

The coordinator service is unauthenticated and binds to the loopback
interface by default. Binding to a non-loopback host is refused unless
`allowInsecure: true` is explicitly set (trusted-LAN opt-in). TLS/mTLS for
the coordinator↔node link is a pending product decision (PD-1) — do not
expose a coordinator on an untrusted network in v1.
