# Participant example (`@express-token-revoker/node`)

Minimal distributed participant: replicates revocation events from the
coordinator over the ordered gRPC stream and serves the Express revocation
middleware from **local state** (the request path never contacts the
coordinator).

## Run

Requires a running coordinator — see
[`packages/server/examples/coordinator/`](../../server/examples/coordinator/README.md).

From the monorepo root:

```bash
pnpm install
pnpm build                       # builds core + server + node

# 1. Generate the TLS material once (requires the openssl CLI) — the
#    coordinator and every node must trust the SAME CA:
node scripts/gen-certs.mjs       # -> ./certs at the repo root

# 2. Configure:
cd packages/node/examples/participant
cp .env.example .env             # then edit .env (secret, CA path)

# 3. Start:
node --env-file=.env participant.js
```

Try it:

```bash
curl -H 'Authorization: my-token' localhost:3000/protected
curl localhost:3000/health
```

## Notes

- All configuration is read from the environment — see `.env.example`
  (placeholders only; fill in real values).
- Revocations are coordinator-only: `node.add()` always throws. Revoke on
  the coordinator and the node picks the delta up via the stream.
- Coordinator down ⇒ the node keeps serving checks from local state
  (degraded mode) and refuses new revocations (PD-2).
- Auth modes and requirements per mode: `docs/distributed-architecture.md`,
  section "Authentification (PD-1)".
