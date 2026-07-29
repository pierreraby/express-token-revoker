# Express Token Revoker

High-performance, crash-safe token revocation for Express — Bloom filters with automatic rotation, WAL-based crash recovery, and optional gRPC admin.

This is a **pnpm-workspaces monorepo**. Revocation state is currently managed per-process (standalone); a distributed mode (coordinated multi-instance revocation) is on the roadmap.

## Packages

| Package | npm | Status | Description |
| ------- | --- | ------ | ----------- |
| [`packages/core`](./packages/core) | [`express-token-revoker`](https://www.npmjs.com/package/express-token-revoker) | ✅ Published | Standalone revocation middleware: in-process Bloom filters, rotation, crash-safe WAL backup, optional gRPC admin. |
| `packages/server` | _TBD_ | 🚧 Planned | Distributed coordinator — synchronizes revocation state across instances. |
| `packages/node` | _TBD_ | 🚧 Planned | Distributed participant — joins a cluster and enforces shared revocation state. |

See the [core package README](./packages/core/README.md) for installation, API reference, reliability model, and benchmarks.

## Development

Requires Node ≥ 20 and pnpm.

```bash
pnpm install        # install the whole workspace
pnpm build          # build the core package
pnpm test           # run the core test suite
pnpm bench          # run the benchmark suite (builds first)
```

All root scripts delegate to the `express-token-revoker` package via `pnpm --filter`. To work inside the package directly: `cd packages/core`.

## License

MIT — see [LICENSE](./LICENSE). Includes `packages/core/src/bloomfilter.ts`, derived from Jason Davies' [bloomfilter.js](https://github.com/jasondavies/bloomfilter.js) (BSD-3-Clause).
