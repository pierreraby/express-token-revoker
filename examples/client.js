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

let tokens = [];

for (let i = 0; i < 1000; i++) {
  tokens.push(jwt.sign({
    sub: `4466554400${i}`,
    fam: `a716-4466554400${i}`,
    jti: `4466554400${i}`,
    name: `John Doe ${i}`,
  }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' }));
}
console.log(`Generated ${tokens.length} tokens`);


let cpt = 0;

// verify tokens is not blacklisted
for (let i = 0; i < tokens.length; i++) {
  const verify = await fetch('http://localhost:3000/protected', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens[i]}`,
    },
  });
  const data = await verify.json();
  if (!data.error) {
    cpt++;
  }
}
console.log(`Verified ${cpt} tokens in the whitelist`);

cpt = 0;

// revoke tokens

for (let i = 0; i < tokens.length/2; i++) {
  const revoke = await fetch(`http://localhost:3000/revoke/jti/4466554400${i}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
  });
  const data = await revoke.json();
  if (!data.error) {
    cpt++;
  }
}
console.log(`Revoked ${cpt} tokens`);

let valid = 0;
let invalid = 0;

// verify tokens is blacklisted
for (let i = 0; i < tokens.length; i++) {
  const verify = await fetch('http://localhost:3000/protected', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens[i]}`,
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

const metricsResponse = await fetch('http://localhost:3000/metrics', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`,
  },
});
const metrics = await metricsResponse.json();

console.log(metrics);



