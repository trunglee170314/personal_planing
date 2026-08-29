import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import worker, {
  isTrustedPushEndpoint,
  notificationCopy,
  run,
} from '../push-worker/index';
import { buildWebPushRequest } from '../push-worker/web-push';

let env = {
  SUPABASE_URL: 'https://database.example',
  SUPABASE_SERVICE_ROLE_KEY: 'secret',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
  VAPID_SUBJECT: 'https://myplan.example',
};
let subscriptionKeys = { p256dh: '', auth: '' };
let clientPrivateKey: CryptoKey;
let clientPublicBytes = new Uint8Array();
let authSecret = new Uint8Array();

function base64Url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Buffer.from(bytes).toString('base64url');
}

function bytes(...values: Uint8Array[]) {
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

beforeAll(async () => {
  const vapidKeys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const vapidPublic = await crypto.subtle.exportKey('raw', vapidKeys.publicKey);
  const vapidPrivate = await crypto.subtle.exportKey(
    'jwk',
    vapidKeys.privateKey,
  );
  env = {
    ...env,
    VAPID_PUBLIC_KEY: base64Url(vapidPublic),
    VAPID_PRIVATE_KEY: vapidPrivate.d!,
  };
  const clientKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  clientPrivateKey = clientKeys.privateKey;
  clientPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', clientKeys.publicKey),
  );
  authSecret = crypto.getRandomValues(new Uint8Array(16));
  subscriptionKeys = {
    p256dh: base64Url(clientPublicBytes),
    auth: base64Url(authSecret),
  };
});

function job(id: string, endpoint: string) {
  return {
    subscription_id: `subscription-${id}`,
    owner_user_id: `owner-${id}`,
    endpoint,
    ...subscriptionKeys,
    calendar_entry_id: `entry-${id}`,
    occurrence_start: '2026-09-01T01:00:00.000Z',
    offset_minutes: 5,
    item_type: 'reminder' as const,
    item_title: `Reminder ${id}`,
  };
}

describe('Web Push worker', () => {
  it('exposes only the existing public VAPID key for browser setup', async () => {
    const response = await worker.fetch(
      new Request('https://push.example/config'),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({
      vapidPublicKey: env.VAPID_PUBLIC_KEY,
    });
  });

  it('keeps the legacy scheduler active when alarm mode is not configured', async () => {
    const response = await worker.fetch(
      new Request('https://push.example/health'),
      env,
    );
    expect(await response.json()).toEqual({
      ok: true,
      service: 'myplan-push',
      scheduler: 'cron',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only known Web Push provider endpoints', () => {
    expect(
      isTrustedPushEndpoint('https://fcm.googleapis.com/fcm/send/one'),
    ).toBe(true);
    expect(isTrustedPushEndpoint('https://web.push.apple.com/QWERTY')).toBe(
      true,
    );
    expect(isTrustedPushEndpoint('https://example.com/private')).toBe(false);
    expect(
      isTrustedPushEndpoint('http://fcm.googleapis.com/fcm/send/one'),
    ).toBe(false);
  });

  it('uses the item title and explicit timing in notification copy', () => {
    expect(
      notificationCopy({
        item_type: 'reminder',
        item_title: 'Uống thuốc',
        offset_minutes: 0,
      }),
    ).toEqual({ title: 'Uống thuốc', body: 'Reminder due now.' });
    expect(
      notificationCopy({
        item_type: 'checklist',
        item_title: 'IELTS Listening',
        offset_minutes: 15,
      }),
    ).toEqual({
      title: 'IELTS Listening',
      body: 'Checklist starts in 15 minutes.',
    });
  });

  it('builds an RFC 8291 aes128gcm payload that the subscriber can decrypt', async () => {
    const message = JSON.stringify({ title: 'myplan test', body: 'hello' });
    const request = await buildWebPushRequest(
      message,
      {
        endpoint: 'https://web.push.apple.com/device',
        ...subscriptionKeys,
      },
      {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    );
    const headers = new Headers(request.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('authorization')).toMatch(
      /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/,
    );
    expect(headers.has('crypto-key')).toBe(false);

    const body = request.body as Uint8Array;
    const salt = body.slice(0, 16);
    expect(
      new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0),
    ).toBe(4096);
    expect(body[20]).toBe(65);
    const senderPublicBytes = body.slice(21, 86);
    const senderPublicKey = await crypto.subtle.importKey(
      'raw',
      asBuffer(senderPublicBytes),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: senderPublicKey },
        clientPrivateKey,
        256,
      ),
    );
    const encoder = new TextEncoder();
    const inputKeyMaterial = await hkdf(
      sharedSecret,
      authSecret,
      bytes(
        encoder.encode('WebPush: info'),
        new Uint8Array([0]),
        clientPublicBytes,
        senderPublicBytes,
      ),
      32,
    );
    const key = await hkdf(
      inputKeyMaterial,
      salt,
      bytes(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
      16,
    );
    const nonce = await hkdf(
      inputKeyMaterial,
      salt,
      bytes(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])),
      12,
    );
    const decryptionKey = await crypto.subtle.importKey(
      'raw',
      asBuffer(key),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBuffer(nonce), tagLength: 128 },
        decryptionKey,
        asBuffer(body.slice(86)),
      ),
    );
    expect(plaintext.at(-1)).toBe(2);
    expect(new TextDecoder().decode(plaintext.slice(0, -1))).toBe(message);
  });

  it('releases a failed claim and continues with later jobs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = job('one', 'https://fcm.googleapis.com/fcm/send/one');
    const second = job('two', 'https://web.push.apple.com/two');
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const method = init?.method ?? 'GET';
        requests.push({ url, method });
        if (url.endsWith('/rest/v1/rpc/get_due_push_jobs'))
          return new Response(JSON.stringify([first, second]), { status: 200 });
        if (url.includes('/rest/v1/push_delivery_log') && method === 'POST')
          return new Response(JSON.stringify([{ id: 1 }]), { status: 201 });
        if (url.includes('/rest/v1/push_delivery_log') && method === 'DELETE')
          return new Response('temporary', { status: 500 });
        if (url === first.endpoint)
          return new Response('temporary', { status: 500 });
        if (url === second.endpoint) {
          const requestHeaders = new Headers(init?.headers);
          expect(requestHeaders.get('content-encoding')).toBe('aes128gcm');
          expect(requestHeaders.get('authorization')).toMatch(
            /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/,
          );
          expect(requestHeaders.has('crypto-key')).toBe(false);
          return new Response(null, { status: 201 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await expect(run(env)).resolves.toBe(1);
    expect(
      requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.url.includes('/rest/v1/push_delivery_log'),
      ),
    ).toBe(true);
    expect(requests.some((request) => request.url === second.endpoint)).toBe(
      true,
    );
  });

  it('uses a one-time server-verified request for a real push test', async () => {
    const requestId = 'c5f2e20c-b44d-49e8-bb19-b968ba21ea40';
    const endpoint = 'https://web.push.apple.com/test-device';
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const method = init?.method ?? 'GET';
        requests.push({ url, method });
        if (url.includes('/push_test_requests?') && method === 'PATCH') {
          const body = JSON.parse(
            typeof init?.body === 'string' ? init.body : '{}',
          ) as {
            claimed_at?: string;
          };
          return new Response(
            JSON.stringify(
              body.claimed_at ? [{ subscription_id: 'subscription-test' }] : [],
            ),
            { status: 200 },
          );
        }
        if (url.includes('/push_subscriptions?'))
          return new Response(
            JSON.stringify([
              {
                id: 'subscription-test',
                endpoint,
                ...subscriptionKeys,
              },
            ]),
            { status: 200 },
          );
        if (url === endpoint) {
          const requestHeaders = new Headers(init?.headers);
          expect(requestHeaders.get('content-encoding')).toBe('aes128gcm');
          expect(requestHeaders.get('authorization')).toContain('vapid t=');
          expect(
            new Uint8Array(init?.body as Uint8Array).byteLength,
          ).toBeGreaterThan(86);
          return new Response(null, { status: 201 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const response = await worker.fetch(
      new Request('https://myplan-push.example/test', {
        method: 'POST',
        headers: {
          origin: 'https://myplan.trungvanle.workers.dev',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requestId }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(requests.some((request) => request.url === endpoint)).toBe(true);
    expect(
      requests.some(
        (request) =>
          request.method === 'PATCH' &&
          request.url.includes(`/push_test_requests?id=eq.${requestId}`),
      ),
    ).toBe(true);
  });

  it('rejects push tests from an untrusted web origin', async () => {
    const response = await worker.fetch(
      new Request('https://myplan-push.example/test', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: 'c5f2e20c-b44d-49e8-bb19-b968ba21ea40',
        }),
      }),
      env,
    );
    expect(response.status).toBe(403);
  });
});
