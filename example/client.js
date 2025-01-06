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

console.log(token);

const adminToken = jwt.sign({
  sub: '1234567890',
  fam: '1234567890',
  jti: '1234567890',
  name: 'John Doe',
  admin: '987654321-1234567890',
}, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

console.log(adminToken);

// check access to protected route with valid JWT token
const reqValid = await fetch('http://localhost:3000/protected', {
  'headers': {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
});

const data = await reqValid.json();
console.log('JWT valid token :' + data.message);

// revoke JWT token
for (let i = 0; i < 100000; i++) {
  const adminRevocation = await fetch('http://localhost:3000/revoke/jti/' + i, {
    'method': 'POST',
    'headers': {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
    },
  });
  // const data2 = await adminRevocation.json();
  // console.log('Revocation JWT' + data2.message);
}

exit(0);

// revoke JWT token
const adminRevocation = await fetch('http://localhost:3000/revoke/jti/' + jti, {
  'method': 'POST',
  'headers': {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`,
  },
});

const data2 = await adminRevocation.json();
console.log('Revocation JWT' + data2.message);

// check access to protected route with invalid JWT token
const reqInvalid = await fetch('http://localhost:3000/protected', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
});

const data3 = await reqInvalid.json();
console.log('JWT invalid token : ' + data3.message);

// check access to protected route with valid opaque token
const reqOpaqueValid = await fetch('http://localhost:3000/protected2', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${opaqueToken}`,
  },
});

const data4 = await reqOpaqueValid.json();
console.log('Opaque valid token :' + data4.message);

// revoke opaque token
const adminOpaqueRevocation = await fetch('http://localhost:3000/revoke2/' + opaqueToken, {
  'method': 'POST',
  'headers': {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`,
  },
});

const data5 = await adminOpaqueRevocation.json();
console.log('Revocation opaque' + data5.message);

// check access to protected route with invalid opaque token
const reqOpaqueInvalid = await fetch('http://localhost:3000/protected2', {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${opaqueToken}`,
  },
});

const data6 = await reqOpaqueInvalid.json();
console.log('Opaque invalid token : ' + data6.message);

// check access to protected route with valid opaque token 'X-Auth-Token'
const reqOpaqueInvalid2 = await fetch('http://localhost:3000/protected3', {
  headers: {
    'Content-Type': 'application/json',
    'X-Auth-Token': `${opaqueToken}`,
  },
});

const data7 = await reqOpaqueInvalid2.json();
console.log('Opaque valid token : ' + data7.message);

// revoke opaque token 'X-Auth-Token'
const adminOpaqueRevocation2 = await fetch('http://localhost:3000/revoke3/' + opaqueToken, {
  'method': 'POST',
  'headers': {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${adminToken}`,
  },
});

const data8 = await adminOpaqueRevocation2.json();
console.log('Revocation opaque X-Auth-Token : ' + data8.message);

// check access to protected route with invalid opaque token 'X-Auth-Token'
const reqOpaqueInvalid4 = await fetch('http://localhost:3000/protected3', {
  headers: {
    'Content-Type': 'application/json',
    'X-Auth-Token': `${opaqueToken}`,
  },
});

const data9 = await reqOpaqueInvalid4.json();
console.log('Opaque invalid token X-Auth-Token : ' + data9.message);