import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static TLS test fixtures (committed, generated ONCE with openssl — see
 * scripts/gen-certs.mjs for the production equivalent). Never generated at
 * test runtime: CA + server cert (SAN DNS:localhost,IP:127.0.0.1) + two
 * client certs, 100-year validity.
 */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures'
);

export const fixtures = {
  caCertPath: path.join(FIXTURES_DIR, 'ca-cert.pem'),
  serverCertPath: path.join(FIXTURES_DIR, 'server-cert.pem'),
  serverKeyPath: path.join(FIXTURES_DIR, 'server-key.pem'),
  client1CertPath: path.join(FIXTURES_DIR, 'client-1-cert.pem'),
  client1KeyPath: path.join(FIXTURES_DIR, 'client-1-key.pem'),
  client2CertPath: path.join(FIXTURES_DIR, 'client-2-cert.pem'),
  client2KeyPath: path.join(FIXTURES_DIR, 'client-2-key.pem'),
} as const;

/** A valid shared secret for tests (>= 16 chars, Joi minimum). */
export const TEST_SHARED_SECRET = 'test-shared-secret-0123456789';
