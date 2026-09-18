import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { upload } from '../src/commands/upload.js';
import { send } from '../src/http.js';
import { UploadError, pooled } from '../src/upload.js';

/**
 * How long a failing upload is allowed to hold a CI job.
 *
 * Every request already had a timeout and a retry budget, and neither bounds the run: a build of
 * forty batches against a server that answers slowly spends forty timeouts, three times over. These
 * pin the two things that do bound it: the deadline for the whole upload, and stopping as soon as
 * the outcome is known.
 */

/** Three chunks, each with a map of its own. */
async function build(count = 3): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-deadline-'));
  for (let i = 0; i < count; i += 1) {
    await writeFile(join(dir, `c${i}.js`), `chunk(${i});\n//# sourceMappingURL=c${i}.js.map\n`, 'utf8');
    await writeFile(join(dir, `c${i}.js.map`), JSON.stringify({ version: 3, sources: [`c${i}.ts`], mappings: 'AAAA' }), 'utf8');
  }

  return dir;
}

/**
 * A server whose `/check` publishes a batch size of one byte, so every map is a batch of its own,
 * and whose upload route is whatever the test says.
 */
async function ingest(
  handle: (request: IncomingMessage, response: ServerResponse, nth: number) => void,
  run: (host: string, started: () => number) => Promise<void>,
): Promise<void> {
  let started = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    if ((request.url ?? '').endsWith('/check')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stored: [], limits: { maxBatchBytes: 1 } }));

      return;
    }

    started += 1;
    handle(request, response, started);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await run(`http://127.0.0.1:${port}`, () => started);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const silent = (): void => {};
const OPTIONS = { key: 'vnk_sk_cli', release: 'r1', urlPrefix: '~/', dryRun: false, inject: false } as const;

describe('the deadline for a whole upload', () => {
  it('abandons a server that never answers, and says how long it waited', async () => {
    await ingest(
      () => {
        // Accept the request and say nothing, which is what a half-open connection looks like.
      },
      async (host, started) => {
        const began = Date.now();
        const failure = await upload(await build(), { ...OPTIONS, host, concurrency: 1, deadlineMs: 250 }, silent).catch(
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(UploadError);
        expect((failure as UploadError).code).toBe('deadline');
        expect((failure as UploadError).message).toContain('did not finish within');
        expect(Date.now() - began).toBeLessThan(3_000);
        // The first batch was in flight when the deadline fired; the other two never started.
        expect(started()).toBe(1);
      },
    );
  });

  it('covers the pre-flight too, so a hung check cannot outlast it', async () => {
    const server: Server = createServer((request) => void request.resume());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const began = Date.now();
      await expect(upload(await build(1), { ...OPTIONS, host, deadlineMs: 200 }, silent)).rejects.toMatchObject({
        code: 'deadline',
      });
      expect(Date.now() - began).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ends the wait between two attempts as well', async () => {
    // A 503 with a long Retry-After: the wait between attempts has to end with the deadline too.
    await ingest(
      (_request, response) => {
        response.writeHead(503, { 'retry-after': '30' }).end('{}');
      },
      async (host) => {
        const began = Date.now();
        await expect(
          upload(await build(1), { ...OPTIONS, host, deadlineMs: 250 }, silent),
        ).rejects.toMatchObject({ code: 'deadline' });
        expect(Date.now() - began).toBeLessThan(3_000);
      },
    );
  });

  it('honours a signal the caller passes, for a build tool with its own cancel', async () => {
    const controller = new AbortController();
    await ingest(
      () => {
        controller.abort(new Error('the build was cancelled'));
      },
      async (host) => {
        await expect(
          upload(await build(1), { ...OPTIONS, host, signal: controller.signal }, silent),
        ).rejects.toThrow('the build was cancelled');
      },
    );
  });
});

describe('once the outcome is known', () => {
  it('starts no further batch after one is refused', async () => {
    // Two in flight over six batches. The first is refused at once; the second is slow. The old
    // pool kept its second runner pulling batches until the list was empty.
    await ingest(
      (_request, response, nth) => {
        if (nth === 1) {
          response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_api_key"}');

          return;
        }
        setTimeout(() => response.writeHead(201).end('{"stored":1}'), 1_500);
      },
      async (host, started) => {
        const began = Date.now();
        await expect(upload(await build(6), { ...OPTIONS, host, concurrency: 2 }, silent)).rejects.toMatchObject({
          code: 'invalid_api_key',
        });

        expect(started()).toBeLessThanOrEqual(2);
        // The slow one was aborted rather than waited for.
        expect(Date.now() - began).toBeLessThan(1_200);
      },
    );
  });

  it('stops the pool on the first failure and reports that failure', async () => {
    const controller = new AbortController();
    const begun: number[] = [];

    const outcome = pooled(
      [0, 1, 2, 3, 4, 5],
      2,
      async (item) => {
        begun.push(item);
        if (item === 0) throw new Error('refused');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          controller.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });

        return item;
      },
      controller,
    );

    await expect(outcome).rejects.toThrow('refused');
    expect(begun).toEqual([0, 1]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('still runs everything when nothing fails', async () => {
    expect(await pooled([1, 2, 3, 4, 5], 2, async (item) => item * 2, new AbortController())).toEqual([2, 4, 6, 8, 10]);
  });
});

describe('the timeout of one request', () => {
  it('bounds the whole request on the proxy path, not the gap between bytes', async () => {
    // A proxy that answers the headers and then drips a byte every 50 ms for ever. A socket-idle
    // timeout of 300 ms never fires against that; a whole-request one does.
    const timers: NodeJS.Timeout[] = [];
    const proxy: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      timers.push(setInterval(() => response.write(' '), 50));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as { port: number }).port;

    try {
      const began = Date.now();
      await expect(
        send({
          method: 'GET',
          url: 'http://ingest.example/v1/health',
          timeoutMs: 300,
          env: { http_proxy: `http://127.0.0.1:${port}` },
        }),
      ).rejects.toThrow('timed out after 300 ms');
      expect(Date.now() - began).toBeLessThan(2_000);
    } finally {
      for (const timer of timers) clearInterval(timer);
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('bounds the whole request without a proxy as well', async () => {
    const timers: NodeJS.Timeout[] = [];
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      timers.push(setInterval(() => response.write(' '), 50));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(
        send({ method: 'GET', url: `http://127.0.0.1:${port}/v1/health`, timeoutMs: 300, env: {} }),
      ).rejects.toThrow('timed out after 300 ms');
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
