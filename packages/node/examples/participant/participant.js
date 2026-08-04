// Minimal distributed participant demo for @express-token-revoker/node.
//
// The node replicates revocation events from the coordinator over the
// ordered gRPC stream and serves the Express middleware from LOCAL state —
// the request path never contacts the coordinator. Configuration is read
// from the environment — see .env.example.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRevokerNode } from '@express-token-revoker/node';
import express from 'express';
import logger from './logger.js';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));

// Auth (PD-1): must be compatible with the coordinator's AUTH_MODE —
// 'shared-secret' (default), 'mtls' or 'insecure' (dev-only). See
// docs/distributed-architecture.md, section "Authentification (PD-1)".
const authMode = process.env.AUTH_MODE || 'shared-secret';
const auth = { mode: authMode };
if (authMode !== 'insecure') {
  auth.secret = process.env.REVOKER_SECRET;
  auth.caCertPath = process.env.NODE_CA_CERT_PATH;
  if (authMode === 'mtls') {
    auth.clientCertPath = process.env.NODE_CLIENT_CERT_PATH;
    auth.clientKeyPath = process.env.NODE_CLIENT_KEY_PATH;
  }
}

const node = await createRevokerNode({
  nodeId: process.env.NODE_ID || 'node-demo',
  coordinatorAddress: process.env.COORDINATOR_ADDRESS || '127.0.0.1:50100',
  logger,
  backupDir: process.env.NODE_BACKUP_DIR || path.join(exampleDir, 'backup'),
  opaqueHeader: process.env.REVOKER_HEADER || 'authorization',
  filter: {
    // Geometry MUST match the coordinator. rotateTime is the expected
    // COORDINATOR rotateTime (the node derives its own safety timeout).
    numItems: Number(process.env.REVOKER_NUM_ITEMS || 1_000_000),
    fpRate: Number(process.env.REVOKER_FP_RATE || 1e-9),
    rotateTime: Number(process.env.REVOKER_ROTATE_TIME_MS || 15 * 60 * 1000),
  },
  auth,
});

const app = express();
const port = Number(process.env.NODE_PORT || 3000);

// Revocation check against the local filter (401 if possibly revoked).
app.get('/protected', node.getMiddleware(), (_req, res) => {
  res.json({ message: 'Token is not revoked' });
});

// Health: core checks + the sync component (connected/mode/dirty).
app.get('/health', (_req, res) => {
  const health = node.healthCheck();
  res.status(health.healthy ? 200 : 503).json(health);
});

app.get('/metrics', (_req, res) => {
  res.json(node.getMetrics());
});

const server = app.listen(port, () => {
  logger.info(`Participant '${node.nodeId}' HTTP listening on port ${port}`);
});

const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down`);
  server.close();
  await node.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
