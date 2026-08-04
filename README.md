# Express Token Revoker

High-performance, crash-safe token revocation for Express — Bloom filters with automatic rotation, WAL-based crash recovery, and optional gRPC admin.

This is a **pnpm-workspaces monorepo**. Revocation state is managed per-process (standalone) by the published core package; a distributed mode (coordinated multi-instance revocation) is available in **alpha** via the private `packages/server` / `packages/node` packages.

## Packages

| Package | npm | Status | Description |
| ------- | --- | ------ | ----------- |
| [`packages/core`](./packages/core) | [`express-token-revoker`](https://www.npmjs.com/package/express-token-revoker) | ✅ Published | Standalone revocation middleware: in-process Bloom filters, rotation, crash-safe WAL backup, optional gRPC admin. |
| `packages/server` | _TBD_ | 🧪 Alpha | Distributed coordinator — synchronizes revocation state across instances. |
| `packages/node` | _TBD_ | 🧪 Alpha | Distributed participant — joins a cluster and enforces shared revocation state. |

See the [core package README](./packages/core/README.md) for installation, API reference, reliability model, and benchmarks. Distributed quickstart (protocol, node state machine, recovery, auth): [`docs/distributed-architecture.md`](./docs/distributed-architecture.md), with runnable examples in `packages/server/examples/coordinator/` and `packages/node/examples/participant/`.

## Development

Requires Node ≥ 20 and pnpm.

```bash
pnpm install        # install the whole workspace
pnpm build          # build all packages (core, server, node)
pnpm test           # run all test suites (core, server, node)
pnpm bench          # run the benchmark suite (builds first)
```

`pnpm build` / `pnpm test` run across every package in topological order (`pnpm -r`); the other root scripts delegate to the `express-token-revoker` package via `pnpm --filter`. To work inside a package directly: `cd packages/core` (or `packages/server` / `packages/node`).

## License

MIT — see [LICENSE](./LICENSE). Includes `packages/core/src/bloomfilter.ts`, derived from Jason Davies' [bloomfilter.js](https://github.com/jasondavies/bloomfilter.js) (BSD-3-Clause).
