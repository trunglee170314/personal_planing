const encoder = new TextEncoder();

type WebPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type VapidKeys = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

function decodeBase64Url(value: string) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function join(...values: Uint8Array[]) {
  const result = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function asBuffer(value: Uint8Array) {
  return Uint8Array.from(value).buffer;
}

async function hkdf(
  input: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    asBuffer(input),
    'HKDF',
    false,
    ['deriveBits'],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: asBuffer(salt),
        info: asBuffer(info),
      },
      key,
      length * 8,
    ),
  );
}

async function vapidAuthorization(endpoint: string, vapid: VapidKeys) {
  const publicBytes = decodeBase64Url(vapid.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4)
    throw new Error('The VAPID public key is invalid.');
  const privateBytes = decodeBase64Url(vapid.privateKey);
  if (privateBytes.length !== 32)
    throw new Error('The VAPID private key is invalid.');
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: encodeBase64Url(publicBytes.slice(1, 33)),
      y: encodeBase64Url(publicBytes.slice(33, 65)),
      d: vapid.privateKey,
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const jwtHeader = encodeBase64Url(
    encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const jwtBody = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${jwtHeader}.${jwtBody}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      asBuffer(encoder.encode(signingInput)),
    ),
  );
  if (signature.length !== 64)
    throw new Error(
      'The Web Crypto runtime returned an invalid ES256 signature.',
    );
  return `vapid t=${signingInput}.${encodeBase64Url(signature)}, k=${vapid.publicKey}`;
}

async function encryptPayload(
  payload: Uint8Array,
  subscription: WebPushSubscription,
) {
  if (payload.length > 3993)
    throw new Error('The Web Push payload is too large.');
  const userPublicBytes = decodeBase64Url(subscription.p256dh);
  const authSecret = decodeBase64Url(subscription.auth);
  if (userPublicBytes.length !== 65 || userPublicBytes[0] !== 4)
    throw new Error('The subscription public key is invalid.');
  if (authSecret.length !== 16)
    throw new Error('The subscription auth secret is invalid.');

  const userPublicKey = await crypto.subtle.importKey(
    'raw',
    asBuffer(userPublicBytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const senderKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const senderPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKeys.publicKey),
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: userPublicKey },
      senderKeys.privateKey,
      256,
    ),
  );
  const inputKeyMaterial = await hkdf(
    sharedSecret,
    authSecret,
    join(
      encoder.encode('WebPush: info'),
      new Uint8Array([0]),
      userPublicBytes,
      senderPublicBytes,
    ),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(
    inputKeyMaterial,
    salt,
    join(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    inputKeyMaterial,
    salt,
    join(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])),
    12,
  );
  const plaintext = join(payload, new Uint8Array([2]));
  const encryptionKey = await crypto.subtle.importKey(
    'raw',
    asBuffer(contentEncryptionKey),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBuffer(nonce), tagLength: 128 },
      encryptionKey,
      asBuffer(plaintext),
    ),
  );

  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = senderPublicBytes.length;
  header.set(senderPublicBytes, 21);
  return join(header, ciphertext);
}

export async function buildWebPushRequest(
  data: string,
  subscription: WebPushSubscription,
  vapid: VapidKeys,
  ttl = 300,
) {
  const body = await encryptPayload(encoder.encode(data), subscription);
  return {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
    },
    body,
  } satisfies RequestInit;
}
