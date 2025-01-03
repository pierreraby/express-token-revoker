// @ts-check
import express from 'express';
import { auth, admin } from './middlewares/auth.js';
import {JWTrevoker, JWTfilter, opaqueRevoker, opaqueFilter,
        opaqueRevokerCustom, opaqueFilterCustom} from './middlewares/revoker.js';

const app = express();
const port = process.env.PORT || 3000;;

app.use(express.json());

// Public route protected by JWT filter
app.get('/protected', auth, JWTfilter, (req, res) => {
  res.status(200).json({ message: 'You are authorized!' });
});

// admin route for revoking JWT tokens
app.post('/revoke/:claim/:value', admin, JWTfilter, (req, res) => {
  try {
    const { claim, value } = req.params;
    const filterItem = `${claim}-${value}`;
    JWTrevoker.add(filterItem);
    res.status(200).json({ message: 'Token revoked' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error }` });
  }
});

// Public route protected by opaque token filter with default header (Authorization)
app.get('/protected2', opaqueFilter, (req, res) => {
  res.status(200).json({ message: 'You are authorized!' });
});

// admin route for revoking opaque tokens with default header (Authorization)
app.post('/revoke2/:token', admin, JWTfilter, (req, res) => {
  const { token } = req.params;
  try {
    opaqueRevoker.add(token);
    res.status(200).json({ message: 'Token revoked' });
  } catch(error) {
    res.status(500).json({ message: `Error: ${ error }` });
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
    res.status(500).json({ message: `Error: ${ error }` });
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
