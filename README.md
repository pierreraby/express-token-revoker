# Express Token Revoker

A high-performance, crash-safe token revocation middleware for Express. Uses Bloom filters with automatic rotation to keep memory bounded, with optional disk backup for crash recovery.

**Revoke JWT claims or opaque tokens (API keys, session tokens) in constant time and sub-megabyte memory.**

## Features

- 🚀 **O(1) revocation checks** — Bloom filter with configurable false-positive rate (e.g. 1 in a million)
- 📦 **Bounded memory** — automated filter rotation evicts expired tokens, no unbounded growth
- 💾 **Crash-safe** — synchronous append-only write-ahead log, restored on restart
- 🔄 **Graceful degradation** — rotation continues in memory if disk is unavailable
- 🏥 **Health checks** — storage, filter saturation, and rotation status exposed
- 📊 **Metrics** — counters for add, check, hit, rotation events
- 🔌 **gRPC support** — optional gRPC server for distributed revocation

## Installation

```bash
npm install express-token-revoker
```

## Quick start

### JWT claims revocation

```typescript
import express from 'express';
import { createRevoker } from 'express-token-revoker';

const app = express();

// 1. Create a revoker instance
const revoker = await createRevoker({
  id: 'my-revoker',
  claimsToCheck: ['jti'],       // JWT claims to validate
  payloadKey: 'token',           // req[payloadKey] holds the decoded JWT
  logger: console,
  filter: {
    numItems: 1_000_000,         // expected tokens before rotation
    fpRate: 0.000_001,           // 1 in a million false positive
    rotateTime: 10 * 60_000,     // rotate every 10 minutes
    backup: true,                // persist to disk for crash recovery
    backupRatioTime: 2,          // full backup every rotateTime / 2
  },
});

const middleware = revoker.getMiddleware();

// 2. Protect routes
app.get('/api/protected', authMiddleware, middleware, (req, res) => {
  res.json({ ok: true });
});

// 3. Revoke a token
app.post('/admin/revoke/:jti', adminMiddleware, (req, res) => {
  revoker.add(`jti-${req.params.jti}`);
  res.json({ revoked: true });
});

// 4. Health check
app.get('/health', (req, res) => {
  const h = revoker.healthCheck();
  res.status(h.healthy ? 200 : 503).json(h);
});

// 5. Graceful shutdown
process.on('SIGTERM', async () => {
  await revoker.shutdown();
  process.exit(0);
});

app.listen(3000);
```

### Opaque token / API key revocation

```typescript
const revoker = await createRevoker({
  id: 'api-key-revoker',
  opaqueHeader: 'Authorization',  // checks req.headers.authorization
  logger: console,
  filter: {
    numItems: 500_000,
    fpRate: 0.000_001,
    rotateTime: 30 * 60_000,
    backup: true,
  },
});
```

## Configuration

### `createRevoker(config)`

| Field | Type | Required | Description |
| ------- | ------ | ---------- | ------------- |
| `id` | `string` | ✅ | Unique identifier for this revoker instance |
| `logger` | `GenericLogger` | ✅ | Logger with `info`, `warn`, `error`, `debug` methods |
| `claimsToCheck` | `string[]` | JWT mode | JWT claim names to validate against bloom filter |
| `payloadKey` | `string` | JWT mode | Key on `req` where decoded JWT payload is stored (e.g. `'token'`) |
| `opaqueHeader` | `string` | Opaque mode | HTTP header name to extract the token from (e.g. `'Authorization'`) |
| `grpcEnabled` | `boolean` | No | Enable gRPC server for remote revocation |
| `grpcPort` | `number` | If grpcEnabled | Port for gRPC server |
| `grpcHost` | `string` | `127.0.0.1` | Host to bind the gRPC server to (loopback only by default — see [gRPC mode](#grpc-mode)) |
| `grpcAllowInsecureRemote` | `boolean` | `false` | Allow binding the gRPC admin service without TLS on a non-loopback host. Strongly discouraged |
| `filter` | `FilterConfig` | ✅ | Bloom filter configuration |

### `FilterConfig`

| Field | Type | Default | Description |
| ------- | ------ | --------- | ------------- |
| `numItems` | `number` | — | Expected number of tokens before rotation (max 100,000,000) |
| `fpRate` | `number` | — | Target false-positive rate — exclusive range (0, 1) |
| `rotateTime` | `number` | — | Rotation interval in milliseconds |
| `backup` | `boolean` | `false` | Enable disk persistence |
| `backupDir` | `string` | `./backup` | Directory for backup files |
| `backupRatioTime` | `number` | — | Full backup every `rotateTime / backupRatioTime` ms |
| `bufferEnabled` | `boolean` | `false` | Buffer writes in memory, flush periodically (1s) |
| `bufferMaxSize` | `number` | `numItems × 2` | Max tokens in write buffer before rejecting new `add()` calls |

## API Reference

### `Revoker`

#### `revoker.getMiddleware(): RequestHandler`

Returns the Express middleware. For JWT mode, validates configured claims against the bloom filter. For opaque mode, extracts and checks the token from the configured header.

> **Revocation-only**: the middleware checks whether an *already authenticated* token has been revoked. It does **not** verify signatures or authenticate requests — place it after your authentication middleware (see `examples/standalone/`).
>
> **JWT revocation string format**: a claim is revoked as `` `${claim}-${value}` `` (e.g. `jti-abc123`). Call `add()` with the exact same format.

#### `revoker.add(token: string): void`

Adds a token to the bloom filter (revokes it). **Synchronous** — uses `fs.appendFileSync` for crash safety. Throws on disk failure after 3 retries.

#### `revoker.has(token: string): boolean`

Checks if a token might be revoked. `false` means **definitely not revoked**. `true` means **possibly revoked** (subject to the false-positive rate).

#### `revoker.getMetrics(): Metrics`

Returns estimated filter metrics, configuration, and operation counters.

#### `revoker.healthCheck(): HealthStatus`

Returns structured health status:

- `storage` — whether the backup directory is writable
- `filter` — filter initialized + saturation level
- `rotation` — whether the rotation interval is running

#### `revoker.resetAndRestore(): Promise<void>`

Resets filters in memory and restores from disk backup.

#### `revoker.resetAndClearData(): Promise<void>`

Resets filters and **deletes all backup files**. Irreversible.

#### `revoker.shutdown(): Promise<void>`

Graceful shutdown: rejects new `add()` calls, waits for in-progress rotation, flushes write buffer, destroys resources. Call from `SIGTERM`/`SIGINT` handler.

#### `revoker.destroy(): Promise<void>`

Immediate destruction (no graceful drain). Prefer `shutdown()`.

## Health check response

```json
{
  "healthy": false,
  "checks": {
    "storage": { "healthy": true },
    "filter": {
      "healthy": true,
      "error": "Filter moderately saturated: 2500000 insertions (2.5x capacity). FPR may be elevated — rotation may be failing."
    },
    "rotation": { "healthy": true }
  }
}
```

### Saturation levels

| Ratio (insertions / numItems) | Status | Behavior |
| ------ | -------- | ---------- |
| ≤ 2× | Healthy | Normal operation |
| 2× – 10× | Degraded (healthy=true) | FPR elevated, logged in health check |
| > 10× | Critical (healthy=false) | `add()` is **blocked** — tokens cannot be revoked |

## Metrics

```typescript
const metrics = revoker.getMetrics();
// {
//   estimatedMetrics: { currentCount, previousCount, currentFpRate, previousFpRate },
//   configuration: { numItems, fpRate, rotateTime, backupEnabled, backupRatioTime },
//   counters: {
//     addSucceeded: 1542,
//     addFailed: 3,
//     checks: 89123,
//     hits: 12,        // tokens found in filter (potentially revoked)
//     rotations: 5,
//     rotationsFailed: 0
//   }
// }
```

## Reliability model

### Crash recovery

1. **Write-ahead log**: every `add()` writes synchronously to a temporary file (`<backupDir>/temp-<id>.txt`) *before* updating the in-memory filter. On restart, the temp file is replayed into the current filter.

2. **Periodic full backup**: the entire bloom filter (as a binary blob) is written every `rotateTime / backupRatioTime` ms. On restart, both `current` and `previous` filters are restored from these blobs.

3. **Rotation + backup**: at rotation, the current filter is backed up, renamed to `previous`, and a fresh filter is created. This keeps the disk state in sync with memory.

### Failure modes

| Scenario | Behavior |
| ---------- | ---------- |
| `add()` disk full | 3 retries → error thrown. Token written to stderr as audit fallback. Caller receives error. |
| Backup during rotation fails | Rotation continues in memory. `healthCheck()` reports `storage: unhealthy`. |
| Buffer flush fails (async mode) | Data kept in buffer, retried next interval (1s). Tokens written to stderr as fallback. |
| Buffer full | `add()` throws `InternalError`. Tokens in buffer preserved for retry. |
| Filter saturated (>10× capacity) | `add()` blocked. `healthCheck().filter.healthy = false`. |
| Rotation fails repeatedly | 3 retries with 5s delay, then waits for next interval tick. **Interval is never permanently stopped.** |

### Design trade-offs

- **Synchronous `add()`**: blocks the event loop for ~9µs per call (measured on SATA SSD). Chosen for crash safety — prevents token loss between file write and filter update.
- **Bloom filter**: probabilistic data structure. A 0.0001% FPR means 1 in a million non-revoked tokens will be incorrectly rejected. This is a **denial of service**, not a security bypass — revoked tokens are *always* detected.
- **No batching in sync mode**: each `add()` is an individual `fs.appendFileSync`. Trades throughput for simplicity and crash safety. If you need high-throughput revocation (1000s/sec), use `bufferEnabled: true`.

## Consistency model

### Bloom filter primer

A Bloom filter guarantees:

- If `has(token)` returns `false` → token is **definitely not** in the filter.
- If `has(token)` returns `true` → token is **possibly** in the filter (with probability 1 − FPR).

This means a **revoked token is never missed** — the filter has no false negatives. A **non-revoked token** may be incorrectly flagged with probability equal to the current FPR, causing a 401 rejection. This is a temporary denial of service, not a security bypass.

### False-positive rate by saturation

For a Bloom filter designed for `n` items with target FPR `p`, the effective FPR after inserting `c × n` items is:

```text
FPR(c) = (1 − 2^(−c))^k
```

where `k = ⌈m/n × ln(2)⌉` is the number of hash functions.

| Saturation (c) | FPR (k=20) | Example: 1,000 req/s, 1 month |
| :-: | :-: | :-- |
| 1× (design point) | ~1 × 10⁻⁶ | 0.03 false rejections |
| 2× | ~0.3% | 86,400 false rejections |
| 3× | ~9% | 2.6 million false rejections |
| 5× | ~53% | half of all requests rejected |
| 10× (add blocked) | ~98% | nearly all requests rejected |

> **Key insight**: at only **2× design capacity**, the filter produces ~3,000× more false positives than designed. The 2× health-check warning is not conservative — it signals real degradation.

### Data-loss window

Tokens are at risk between a successful `add()` and the next full backup (`rotateTime / backupRatioTime`).

| Backup interval | Peak add rate | Max tokens at risk |
| :-- | :-- | :-- |
| 2.5 min | 10 /s | 1,500 |
| 2.5 min | 1,000 /s | 150,000 |
| 30 min | 10 /s | 18,000 |

Tokens **in the temp file** (write-ahead log) are always recovered, even without a full backup. The data-loss window only covers tokens added **after** the last snapshot and **before** they are written to the temp file — which is zero in sync mode: every `add()` writes the temp file first, then updates memory. The risk is limited to:

1. Crash between `appendFileSync` completing and OS actually flushing to disk (extremely rare — the OS buffer is usually flushed within seconds).
2. Crash during the async buffer flush window (only when `bufferEnabled: true` — up to 1s of tokens).

### Restore performance

| Operation | 1M-item filter | 10M-item filter |
| :-- | :-- | :-- |
| Read blob from disk | < 1 ms | ~5 ms |
| Replay temp file (100K tokens) | ~900 ms | ~900 ms |
| Total cold start | < 1 s | < 1 s |

### Add latency

| Mode | Latency | Throughput |
| :-- | :-- | :-- |
| Sync (`bufferEnabled: false`) | ~9 µs | ~110,000 /s |
| Buffered (`bufferEnabled: true`) | ~0.1 µs (memory push) | ~10,000,000 /s |

> Sync mode was measured on a SATA SSD. NVMe drives are typically 2–5× faster. Buffered mode trades crash safety for throughput — up to 1s of tokens may be lost on crash.

## gRPC mode

When `grpcEnabled: true`, the revoker exposes a gRPC admin server (`RevokerAdmin`: `Add`, `Has`, `GetMetrics`, `ResetAndRestore`, `ResetAndClearData`, `ListRevokers`). Direct `add()`/`has()` calls on the instance throw — use the gRPC client instead. See `examples/standalone/` for a complete example.

### Security

The admin service is **unauthenticated**. By default it binds to `127.0.0.1` (loopback only), so only local processes can reach it. Binding to a non-loopback `grpcHost` without TLS is **refused at startup** unless you explicitly set `grpcAllowInsecureRemote: true` — only do that on an isolated, trusted network, or (recommended) put TLS/mTLS in front and keep the bind local.

### Topology (standalone)

Revocation state lives **in the process** that runs the revoker. In the current standalone topology, run one gRPC-enabled revoker process and administer it through the gRPC API; other services call it over gRPC. Transparent multi-instance synchronization is on the roadmap (distributed mode).

## Examples

The runnable demo in `examples/standalone/` uses the compiled output:

```bash
npm run build   # once, or after library changes
npm start       # HTTP API + gRPC admin on 127.0.0.1:50051
npm run client  # exercises the API in another terminal
```

## License

MIT — see [LICENSE](./LICENSE). Includes `src/bloomfilter.ts`, derived from Jason Davies' [bloomfilter.js](https://github.com/jasondavies/bloomfilter.js) (BSD-3-Clause).
