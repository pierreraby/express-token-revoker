import jwt from 'jsonwebtoken';
import { exit } from 'process';

const jti = '446655440015';
const opaqueToken = 'WMbQRwfGbYY1qmsmmyRvJ4LKlMrgl5s4OXTXG9OPBrRtFbtpZ1uBHYtBiGjIpT1q';

const token = jwt.sign({
  sub: '446655440000',
  fam: 'a716-446655440001',
  jti: jti,
  name: 'John Doe',
}, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

// console.log(token);

const adminToken = jwt.sign({
  sub: '1234567890',
  fam: '1234567890',
  jti: '1234567890',
  name: 'John Doe',
  admin: '987654321-1234567890',
}, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

// console.log(adminToken);

const generateJWT = (min=0, max=1000) => {
  const tokens = [];
  for (let i = min; i < max; i++) {
    tokens.push(jwt.sign({
      sub: `4466554400${i}`,
      fam: `a716-4466554400${i}`,
      jti: `4466554400${i}`,
      name: `John Doe ${i}`,
    }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' }));
  }
  console.log(`Generated ${tokens.length} tokens`);
  return tokens;
}

const verifyJWT = async (tokens) =>{
  let valid = 0;
  let invalid = 0;
  for (const token of tokens) {
    const verify = await fetch('http://localhost:3000/protected', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
    const data = await verify.json();
    if (data.error) {
      if (data.error === 'invalid_token') {
        invalid++;
      }
    } else {
      valid++;
    }
  }

  console.log(`Verified ${valid} valid tokens and ${invalid} invalid tokens`);
}

const revokeJWT = async (tokens, claim) => {
  let cpt = 0;
  for (const token of tokens) {
    // extract jti from token
    const payload64 = token.split('.')[1];
    const payloadDecoded = Buffer.from(payload64, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadDecoded);

    const revoke = await fetch(`http://localhost:3000/revoke/jti/${payload[claim]}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
    });
    if (revoke.status === 200) {
      cpt++;
    }
  }
  console.log(`Revoked ${cpt} tokens`);
}

const getMetrics = async () => {
  const metricsResponse = await fetch('http://localhost:3000/metrics', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
  });
  const metrics = await metricsResponse.json();
  return metrics;
}

const displayMetrics = async () => {
  const metrics = await getMetrics();
  const { currentCount, previousCount } = metrics.estimatedMetrics;
  console.log(`Current count: ${currentCount}, Previous count: ${previousCount}`);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sequence = async () => {
  const tokens1 = generateJWT();
  await verifyJWT(tokens1);
  await revokeJWT(tokens1, 'jti');
  await verifyJWT(tokens1);
  await displayMetrics();
  await wait(60 * 1000);

  const tokens2 = generateJWT(1000, 2000);
  await revokeJWT(tokens2, 'jti');
  const allTokens = tokens1.concat(tokens2);
  await verifyJWT(allTokens);
  await displayMetrics();
  await wait(60 * 1000);

  await verifyJWT(allTokens);
  await displayMetrics();
  await wait(60 * 1000);

  await verifyJWT(allTokens);
  await displayMetrics();
}

await sequence();



