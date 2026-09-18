import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';

import { doctor } from '../src/commands/doctor.js';

/**
 * `doctor` asks the server one question — would you take an upload from this key — by sending an
 * empty one. Only one answer means yes: the refusal for a missing release, which the server reaches
 * after it has accepted the key and its scope. Everything else is some other state and has to be
 * reported as that state; it used to be reported as ready.
 */
async function against(
  upload: { status: number; body: unknown } | 'hang',
  run: (host: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((request, response) => {
    request.resume();
    if ((request.url ?? '').endsWith('/v1/health')) {
      response.writeHead(200).end('ok');

      return;
    }
    if (upload === 'hang') return;

    response.writeHead(upload.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(upload.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const check = async (upload: Parameters<typeof against>[0], timeoutMs?: number): Promise<{ ok: boolean; text: string }> => {
  const lines: string[] = [];
  let ok = false;
  await against(upload, async (host) => {
    ok = await doctor(host, 'vnk_sk_0123456789abcdef', (line) => lines.push(line), timeoutMs === undefined ? {} : { timeoutMs });
  });

  return { ok, text: lines.join('\n') };
};

describe('doctor', () => {
  it('says ready on the one answer that proves it', async () => {
    const { ok, text } = await check({ status: 400, body: { error: 'missing_release' } });

    expect(ok).toBe(true);
    expect(text).toContain('key accepted       yes');
    expect(text).toContain('upload scope       yes');
    expect(text).toContain('Ready to upload.');
  });

  it('does not say ready when the server is failing', async () => {
    for (const status of [500, 502]) {
      const { ok, text } = await check({ status, body: {} });

      expect(ok).toBe(false);
      expect(text).toContain(`HTTP ${status}`);
      expect(text).toContain('server error');
      expect(text).not.toContain('Ready to upload.');
      expect(text).not.toContain('key accepted       yes');
    }
  });

  it('does not say ready when it is being throttled', async () => {
    const { ok, text } = await check({ status: 429, body: { error: 'rate_limited' } });

    expect(ok).toBe(false);
    expect(text).toContain('throttled');
    expect(text).toContain('HTTP 429');
    expect(text).not.toContain('Ready to upload.');
  });

  it('does not say ready on an answer it does not recognise', async () => {
    const { ok, text } = await check({ status: 404, body: {} });

    expect(ok).toBe(false);
    expect(text).toContain('HTTP 404');
    expect(text).not.toContain('Ready to upload.');
  });

  it('still tells a revoked key from a key without the scope', async () => {
    expect((await check({ status: 401, body: {} })).text).toContain('the key is unknown or revoked');
    expect((await check({ status: 403, body: { error: 'cli_scope_required' } })).text).toContain('lacks the "cli" scope');
  });

  it('gives up on a key check the server never answers', async () => {
    const began = Date.now();
    const { ok, text } = await check('hang', 200);

    expect(ok).toBe(false);
    expect(text).toContain('did not answer within 0.2 s');
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});
