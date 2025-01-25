/* @ts-check */
import express from 'express';
// import logger from '../logger.js';
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
app.post('/restore', admin, (req, res) => {
  try {
    JWTrevoker.restore();
    opaqueRevoker.restore();
    opaqueRevokerCustom.restore();
    res.status(200).json({ message: 'Bloom filters restored' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error.message }` });
  }
});

// admin reset the Bloom filter
app.post('/reset', admin, (req, res) => {
  try {
    JWTrevoker.reset();
    opaqueRevoker.reset();
    opaqueRevokerCustom.reset();
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



// Start the HTTP server
app.listen(port, () => {
  console.log(`API-server HTTP running on port ${port}`);
});

process.on("SIGINT", () => {
  JWTrevoker.destroy();
  opaqueRevoker.destroy();
  opaqueRevokerCustom.destroy();
  process.exit(0);
});
