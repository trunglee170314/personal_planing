import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

describe('service-worker push payloads', () => {
  it.each([
    'Test push message from DevTools',
    '{"title":"Checklist due","body":"Review code"}',
    'null',
    '',
  ])('accepts JSON and non-JSON payload %s', async (text) => {
    const handlers = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn(async () => {});
    runInNewContext(
      readFileSync(
        new URL('../public/service-worker.js', import.meta.url),
        'utf8',
      ),
      {
        self: {
          addEventListener: (name: string, handler: (event: unknown) => void) =>
            handlers.set(name, handler),
          registration: { showNotification },
        },
      },
    );
    let pending: Promise<void> | undefined;
    handlers.get('push')!({
      data: text ? { json: () => JSON.parse(text), text: () => text } : null,
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    });
    await pending;
    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification.mock.calls[0]).toEqual([
      text.startsWith('{') ? 'Checklist due' : 'myplan reminder',
      expect.objectContaining({
        body: text.startsWith('{')
          ? 'Review code'
          : text === 'Test push message from DevTools'
            ? text
            : 'You have an item that needs attention.',
      }),
    ]);
  });
});
