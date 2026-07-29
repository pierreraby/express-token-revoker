// @ts-check 
import express from 'express';
import logger from '../logger.js';
import { ValidationError, InternalError } from '#build/errors.js';
import { auth, admin } from './middlewares/auth.js';
import {JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter,
        opaqueRevokerCustom, opaqueFilterCustom} from './middlewares/revoker.js';

const app = express();
const port = process.env.PORT || 3000;;

app.use(express.json());

// Middleware de journalisation HTTP avec Pino
// app.use((req, res, next) => {
//   logger.info(`Requête reçue: ${req.method} ${req.url}`);
//   next();
// });

// Public route protected by JWT filter
app.get('/protected', auth, JWTfilter, (req, res) => {
  res.status(200).json({ message: 'You are authorized!' });
});

// admin route for revoking JWT tokens
app.post('/revoke/:claim/:value', admin, JWTfilter, async (req, res) => {
  try {
    const { claim, value } = req.params;
    const filterItem = `${claim}-${value}`;
    JWTrevoker.add(filterItem);
    res.status(200).json({ message: 'Token revoked' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// Public route protected by opaque token filter with default header (Authorization)
app.get('/protected2', opaqueFilter, (req, res) => {
  res.status(200).json({ message: 'You are authorized!' });
});

// admin route for revoking opaque tokens with default header (Authorization)
app.post('/revoke2/:token', admin, JWTfilter, async (req, res) => {
  const { token } = req.params;
  try {
    opaqueRevoker.add(token);
    res.status(200).json({ message: 'Token revoked' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// Public route protected by opaque token filter with custom header (X-Auth-Token)
app.get('/protected3', opaqueFilterCustom, (req, res) => {
  res.status(200).json({ message: 'You are authorized!' });
});

// admin route for revoking opaque tokens with custom header (X-Auth-Token)
app.post('/revoke3/:token', admin, JWTfilter, (req, res) => {
  const { token } = req.params;
  try {
    opaqueRevokerCustom.add(token);
    res.status(200).json({ message: 'Token revoked' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// admin restore the Bloom filter
app.post('/restore', admin, async (req, res) => {
  try {
    await JWTrevoker.resetAndRestore();
    await opaqueRevoker.resetAndRestore();
    await opaqueRevokerCustom.resetAndRestore();
    res.status(200).json({ message: 'Bloom filters restored' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// admin reset the Bloom filter
app.post('/reset', admin, async (req, res) => {
  try {
    await JWTrevoker.resetAndClearData();
    await opaqueRevoker.resetAndClearData();
    await opaqueRevokerCustom.resetAndClearData();
    res.status(200).json({ message: 'Bloom filters reset' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// Endpoint to expose JWTrevoker metrics
app.get('/metrics', (req, res) => {
  try {
    const metrics  =  JWTrevoker.getMetrics();
    res.status(200).json(metrics);
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// Global error handling middleware to prevent uncaught errors from going unnoticed
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    // Erreurs de validation
    res.status(400).json({
      error: err.name,
      message: err.message,
    });
  } else if (err instanceof InternalError) {
    // Erreurs internes
    res.status(500).json({
      error: err.name,
      message: err.message || "An unexpected internal error occurred",
    });
  } else {
    // Autres erreurs non spécifiées
    res.status(500).json({
      error: "internal_error",
      message: "An unexpected error occurred",
    });
  }
});

process.on("SIGINT", async () => {
  await JWTrevoker.destroy();
  await opaqueRevoker.destroy();
  await opaqueRevokerCustom.destroy();
  logger.info('Stopping API-server HTTP');
  process.exit(0);
});

// Start the HTTP server
app.listen(port, () => {
  console.log(`API-server HTTP running on port ${port}`);
});


