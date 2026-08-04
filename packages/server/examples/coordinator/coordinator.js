// Minimal distributed coordinator demo for @express-token-revoker/server.
//
// The coordinator owns the canonical WAL and the rotation schedule, and
// serves the ordered replication stream to participant nodes. Configuration
// is read from the environment — see .env.example.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoordinator } from '@express-token-revoker/server';
import logger from './logger.js';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

// Auth (PD-1): 'shared-secret' (default — one-way TLS + shared secret),
// 'mtls' or 'insecure' (dev-only, loopback). See
// docs/distributed-architecture.md, section "Authentification (PD-1)".
const authMode = process.env.AUTH_MODE || 'shared-secret';
const auth = { mode: authMode };
if (authMode !== 'insecure') {
  auth.secret = process.env.REVOKER_SECRET;
  auth.caCertPath = process.env.COORDINATOR_CA_CERT_PATH;
  auth.serverCertPath = process.env.COORDINATOR_SERVER_CERT_PATH;
  auth.serverKeyPath = process.env.COORDINATOR_SERVER_KEY_PATH;
}

const handle = await createCoordinator({
  id: process.env.COORDINATOR_ID || 'coordinator-demo',
  logger,
  port: Number(process.env.COORDINATOR_PORT || 50100),
  host: process.env.COORDINATOR_HOST || '127.0.0.1',
  backupDir: process.env.COORDINATOR_BACKUP_DIR || path.join(exampleDir, 'backup'),
  opaqueHeader: process.env.REVOKER_HEADER || 'authorization',
  filter: {
    // Geometry MUST match on every participant node.
    numItems: Number(process.env.REVOKER_NUM_ITEMS || 1_000_000),
    fpRate: Number(process.env.REVOKER_FP_RATE || 1e-9),
    rotateTime: Number(process.env.REVOKER_ROTATE_TIME_MS || 15 * 60 * 1000),
    backupRatioTime: Number(process.env.REVOKER_BACKUP_RATIO_TIME || 4),
  },
  auth,
});

logger.info(
  `Coordinator listening on ${process.env.COORDINATOR_HOST || '127.0.0.1'}:${handle.port} ` +
    `(auth mode: ${authMode})`
);

// Admin revocation (canonical-first write):
//   const { success, lsn } = handle.coordinator.add('some-opaque-token');
// Participant nodes replicate it over the stream — node.add() always throws.

const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down`);
  await handle.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
