#!/usr/bin/env node
/**
 * gen-certs.mjs — generate TLS material for a real express-token-revoker
 * distributed deployment (coordinator <-> nodes gRPC link, PD-1 auth).
 *
 * What it generates (all PEM, 10-year validity by default):
 *   ca-cert.pem / ca-key.pem        — private CA (trust anchor for both sides)
 *   server-cert.pem / server-key.pem— coordinator cert (SAN: DNS:localhost,
 *                                     IP:127.0.0.1 + any --san you add)
 *   client-cert.pem / client-key.pem— one node client cert (mtls mode);
 *                                     run once per node with a distinct --out
 *
 * Usage:
 *   node scripts/gen-certs.mjs [--out DIR] [--days N] [--san NAME]...
 *
 *   --out DIR   output directory (default: ./certs)
 *   --days N    certificate validity in days (default: 3650)
 *   --san NAME  extra subjectAltName for the server cert (repeatable),
 *               e.g. --san DNS:coord.internal --san IP:10.0.0.5
 *
 * Then wire the paths into the configs:
 *   coordinator: auth: { mode: 'shared-secret' | 'mtls', secret, caCertPath,
 *                serverCertPath, serverKeyPath }
 *   node:        auth: { mode: 'shared-secret' | 'mtls', secret, caCertPath,
 *                clientCertPath, clientKeyPath }   (client paths: mtls only)
 *
 * Requires the `openssl` CLI on PATH. Keep ca-key.pem and every *-key.pem
 * out of source control.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// --- tiny arg parsing ------------------------------------------------------
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}
function repeated(name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) values.push(args[i + 1]);
  }
  return values;
}

const outDir = option('--out', 'certs');
const days = option('--days', '3650');
const extraSans = repeated('--san');

fs.mkdirSync(outDir, { recursive: true });

// run('openssl', [...]) — fail loudly on any openssl error.
function openssl(...cmdArgs) {
  execFileSync('openssl', cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
}
const file = (name) => path.join(outDir, name);

// --- 1. private CA ----------------------------------------------------------
console.log(`[gen-certs] CA -> ${file('ca-cert.pem')}`);
openssl('genrsa', '-out', file('ca-key.pem'), '2048');
openssl(
  'req',
  '-new',
  '-x509',
  '-key',
  file('ca-key.pem'),
  '-out',
  file('ca-cert.pem'),
  '-days',
  days,
  '-subj',
  '/O=express-token-revoker/CN=express-token-revoker CA'
);

// --- 2. coordinator (server) cert with SANs ---------------------------------
// localhost + loopback always included so local/dev binds verify too.
const sans = ['DNS:localhost', 'IP:127.0.0.1', ...extraSans].join(',');
const serverExt = file('server-ext.cnf');
fs.writeFileSync(
  serverExt,
  `subjectAltName=${sans}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`
);
console.log(`[gen-certs] server cert (SAN: ${sans}) -> ${file('server-cert.pem')}`);
openssl('genrsa', '-out', file('server-key.pem'), '2048');
openssl(
  'req',
  '-new',
  '-key',
  file('server-key.pem'),
  '-subj',
  '/O=express-token-revoker/CN=localhost',
  '-out',
  file('server.csr')
);
openssl(
  'x509',
  '-req',
  '-in',
  file('server.csr'),
  '-CA',
  file('ca-cert.pem'),
  '-CAkey',
  file('ca-key.pem'),
  '-CAcreateserial',
  '-days',
  days,
  '-extfile',
  serverExt,
  '-out',
  file('server-cert.pem')
);

// --- 3. node (client) cert for mtls -----------------------------------------
const clientExt = file('client-ext.cnf');
fs.writeFileSync(clientExt, 'keyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n');
console.log(`[gen-certs] client cert -> ${file('client-cert.pem')}`);
openssl('genrsa', '-out', file('client-key.pem'), '2048');
openssl(
  'req',
  '-new',
  '-key',
  file('client-key.pem'),
  '-subj',
  '/O=express-token-revoker/CN=revoker-node',
  '-out',
  file('client.csr')
);
openssl(
  'x509',
  '-req',
  '-in',
  file('client.csr'),
  '-CA',
  file('ca-cert.pem'),
  '-CAkey',
  file('ca-key.pem'),
  '-CAcreateserial',
  '-days',
  days,
  '-extfile',
  clientExt,
  '-out',
  file('client-cert.pem')
);

// --- cleanup CSRs / ext files -------------------------------------------------
for (const name of ['server.csr', 'client.csr', 'server-ext.cnf', 'client-ext.cnf']) {
  fs.rmSync(file(name), { force: true });
}
fs.rmSync(file('ca-cert.srl'), { force: true });

console.log('[gen-certs] done. Protect *-key.pem and ca-key.pem — never commit them.');
