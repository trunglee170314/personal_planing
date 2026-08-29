import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPortAvailable, waitForHttp } from '../scripts/local-startup.mjs';

const servers = [];
async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, url: `http://127.0.0.1:${port}/` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

describe('local startup readiness', () => {
  it('waits for a successful HTTP response, not just an open port', async () => {
    let requests = 0;
    const { url } = await serve((_, response) => {
      response.writeHead(++requests < 3 ? 503 : 200).end();
    });
    await waitForHttp(url, { timeoutMs: 2_000, pollMs: 5 });
    expect(requests).toBe(3);
  });

  it('reports progress while first-page compilation takes time', async () => {
    const { url } = await serve((_, response) => {
      setTimeout(() => response.end('ready'), 100);
    });
    const progress = [];
    await waitForHttp(url, {
      timeoutMs: 2_000,
      progressMs: 20,
      onProgress: (seconds) => progress.push(seconds),
    });
    expect(progress.length).toBeGreaterThan(0);
  });

  it('fails on a service that never answers instead of waiting forever', async () => {
    const { url } = await serve(() => {});
    await expect(
      waitForHttp(url, {
        label: 'Web',
        timeoutMs: 200,
        requestTimeoutMs: 30,
        pollMs: 5,
      }),
    ).rejects.toThrow('Web did not become ready');
  });

  it('does not consider redirects or HTTP errors ready', async () => {
    const { url } = await serve((_, response) => {
      response.writeHead(302, { location: '/login' }).end();
    });
    await expect(
      waitForHttp(url, { timeoutMs: 100, pollMs: 5 }),
    ).rejects.toThrow('HTTP 302');
  });

  it('cancels an in-flight request promptly when a child exits', async () => {
    const controller = new AbortController();
    const { url } = await serve(() => {});
    const waiting = waitForHttp(url, { signal: controller.signal });
    controller.abort(new Error('child stopped'));
    await expect(waiting).rejects.toThrow('child stopped');
  });

  it('rejects an occupied port and allows a released port', async () => {
    const { server, port } = await serve((_, response) => response.end());
    await expect(assertPortAvailable(port, 'Web')).rejects.toThrow(
      'EADDRINUSE',
    );
    await new Promise((resolve) => server.close(resolve));
    await expect(assertPortAvailable(port, 'Web')).resolves.toBeUndefined();
  });
});
