# Coordinator example (`@express-token-revoker/server`)

Minimal distributed coordinator: owns the canonical WAL and the rotation
schedule, serves snapshots and the ordered replication stream to participant
nodes.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build                       # builds core + server + node

# 1. Generate the TLS material once (requires the openssl CLI):
node scripts/gen-certs.mjs       # -> ./certs at the repo root

# 2. Configure:
cd packages/server/examples/coordinator
cp .env.example .env             # then edit .env (secret, cert paths)

# 3. Start:
node --env-file=.env coordinator.js
```

Then start a participant node — see
[`packages/node/examples/participant/`](../../node/examples/participant/README.md).

## Notes

- All configuration is read from the environment — see `.env.example`
  (placeholders only; fill in real values).
- Auth modes and requirements per mode: `docs/distributed-architecture.md`,
  section "Authentification (PD-1)".
- Revocations are coordinator-only: call `handle.coordinator.add(item)`
  (or the gRPC `DistAdd` RPC). Participant nodes refuse `add()`.
