import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export function assertPortAvailable(port, label) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      reject(
        new Error(
          `${label} cannot use 127.0.0.1:${port}: ${error.code}. Stop the existing local server before starting another one.`,
        ),
      );
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export async function waitForHttp(
  url,
  {
    label = 'Service',
    timeoutMs = 300_000,
    // A cold Vite compilation on a Windows-mounted drive can exceed 30 seconds.
    requestTimeoutMs = 120_000,
    pollMs = 1_000,
    progressMs = 15_000,
    signal,
    onProgress = () => {},
  } = {},
) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastError = 'not responding';
  const progress = setInterval(
    () => onProgress(Math.floor((Date.now() - started) / 1_000)),
    progressMs,
  );
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const requestSignal = AbortSignal.timeout(
        Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now())),
      );
      try {
        const response = await fetch(url, {
          signal: signal
            ? AbortSignal.any([signal, requestSignal])
            : requestSignal,
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (response.status === 200) return;
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error instanceof Error ? error.message : String(error);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0)
        await delay(Math.min(pollMs, remaining), undefined, { signal });
    }
    throw new Error(
      `${label} did not become ready within ${timeoutMs / 1_000} seconds at ${url} (${lastError}).`,
    );
  } finally {
    clearInterval(progress);
  }
}
