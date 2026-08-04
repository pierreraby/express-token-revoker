# fixtures/ — throwaway TEST-ONLY TLS certificates

The PEM files in this directory are **test fixtures, not credentials**:

- Generated **once** and committed so the automated test suites
  (`packages/server` auth tests) run without an `openssl` dependency.
- Valid for **100 years** (until 2126) — deliberately, so they never expire
  while the test suites exist.
- **Never use them in a deployment.** The private keys (`*-key.pem`,
  including `ca-key.pem`) are committed here *by design*: they protect
  nothing and are shared with anyone who can read this repository.

For real deployments, generate fresh material with
`node scripts/gen-certs.mjs` (10-year validity by default, output to the
gitignored `certs/` directory) and protect the private keys. See the auth
section of `docs/distributed-architecture.md` for the requirements per
mode.
