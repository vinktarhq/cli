import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { upload } from '../src/commands/upload.js';
import { inject } from '../src/commands/inject.js';
import { discover } from '../src/discover.js';
import { UploadError, batch, mb } from '../src/upload.js';
import { normalise, toUrl } from '../src/url.js';

/**
 * A real HTTP server rather than a fetch mock.
 *
 * Multipart is exactly the kind of thing that looks right in a mock and is wrong on the wire, and
 * the positional pairing of `files[] / urls[] / debug_ids[]` can only be checked by parsing what
 * actually arrived.
 */
interface Captured {
  release: string;
  dist: string;
  files: string[];
  urls: string[];
  debugIds: string[];
  key: string;
}

/**
 * `/v1/sourcemaps/check` is answered separately and never recorded.
 *
 * It is a different endpoint with a different body, so folding it into `seen` would make every
 * assertion about "the upload request" actually be about the pre-flight — and would make the
 * retry test count the pre-flight as an attempt.
 */
async function withServer(
  reply: (captured: Captured) => { status: number; body: unknown },
  run: (host: string, captured: Captured[]) => Promise<void>,
  heldHashes: readonly string[] = [],
): Promise<void> {
  const seen: Captured[] = [];
  let server: Server | undefined;

  try {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if ((request.url ?? '').endsWith('/check')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ stored: heldHashes }));

          return;
        }

        const captured = parseMultipart(
          Buffer.concat(chunks).toString('binary'),
          request.headers['content-type'] ?? '',
          String(request.headers['x-vinktar-key'] ?? ''),
        );
        seen.push(captured);

        const { status, body } = reply(captured);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    if (server !== undefined) await shutdown(server);
  }
}

function parseMultipart(body: string, contentType: string, key: string): Captured {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1] ?? '';
  const captured: Captured = { release: '', dist: '', files: [], urls: [], debugIds: [], key };

  for (const part of body.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    if (name === undefined) continue;

    const value = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');

    if (name === 'release') captured.release = value;
    if (name === 'dist') captured.dist = value;
    if (name === 'files[]') captured.files.push(value);
    if (name === 'urls[]') captured.urls.push(value);
    if (name === 'debug_ids[]') captured.debugIds.push(value);
  }

  return captured;
}

/**
 * Shut a test server down without waiting for the client's keep-alive socket to idle out.
 *
 * `fetch` keeps its connection alive, and on Node 18 `server.close()` waits for every open
 * connection — including an idle keep-alive one — so teardown blocked for the full
 * `keepAliveTimeout` (5 s) and every socket-using test in this file timed out at exactly the 5 s
 * mark. Node 20 closes idle connections itself, which is why this only ever failed on the oldest
 * version in the matrix: the floor the package actually promises.
 */
async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const created: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-cli-'));
  created.push(dir);

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }

  return dir;
}

afterEach(() => {
  created.length = 0;
});

const silent = (): void => {};

describe('upload', () => {
  it('sends the three arrays in matching positional order', async () => {
    // The server pairs files[], urls[] and debug_ids[] BY INDEX. Appending to one without the
    // others mis-pairs every entry after it, and nothing would fail — the maps would just be
    // filed under the wrong URLs and never match a frame.
    const dir = await fixture({
      'a.js': 'const a=1;\n//# sourceMappingURL=a.js.map\n',
      'a.js.map': '{"version":3,"sources":["a.ts"]}',
      'b.js': 'const b=2;\n//# sourceMappingURL=b.js.map\n',
      'b.js.map': '{"version":3,"sources":["b.ts"]}',
    });

    await withServer(
      () => ({ status: 201, body: { stored: 2, artifacts: [] } }),
      async (host, seen) => {
        await upload(
          dir,
          { host, key: 'vnk_pk_test', release: 'r1', urlPrefix: '~/', dryRun: false },
          silent,
        );

        const request = seen[0]!;
        expect(request.files).toHaveLength(2);
        expect(request.urls).toEqual(['~/a.js', '~/b.js']);
        expect(request.debugIds).toHaveLength(2);

        // The id sent alongside each map must be the id written INTO that same map.
        for (const [index, file] of request.files.entries()) {
          expect(JSON.parse(file).debugId).toBe(request.debugIds[index]);
        }
      },
    );
  });

  it('authenticates with the header, and passes the release through', async () => {
    const dir = await fixture({
      'a.js': 'const a=1;',
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    });

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        await upload(
          dir,
          { host, key: 'vnk_pk_secret', release: 'web@1.4.2', dist: 'eu', urlPrefix: '/assets/', dryRun: false },
          silent,
        );

        expect(seen[0]!.key).toBe('vnk_pk_secret');
        expect(seen[0]!.release).toBe('web@1.4.2');
        expect(seen[0]!.dist).toBe('eu');
        expect(seen[0]!.urls).toEqual(['/assets/a.js']);
      },
    );
  });

  it('reuses an id already injected rather than deriving a new one', async () => {
    // Otherwise the map is filed under an id no frame will ever report.
    const dir = await fixture({
      'a.js': 'const a=1;',
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    });

    await inject(dir, silent);
    const [artifact] = (await discover(dir)).artifacts;
    const injectedId = /\/\/# debugId=(.+)/.exec(
      await import('node:fs/promises').then((fs) => fs.readFile(artifact!.file, 'utf8')),
    )?.[1];

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        await upload(dir, { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent);

        expect(seen[0]!.debugIds[0]).toBe(injectedId);
      },
    );
  });

  it('sends nothing on a dry run', async () => {
    const dir = await fixture({ 'a.js': 'const a=1;', 'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}' });

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        const lines: string[] = [];
        const summary = await upload(
          dir,
          { host, key: 'k', release: 'r', urlPrefix: 'https://cdn.example.com/', dryRun: true },
          (line) => lines.push(line),
        );

        expect(seen).toHaveLength(0);
        expect(summary.stored).toBe(0);
        // Shows the NORMALISED url, which is what the server compares a frame against.
        expect(lines.join('\n')).toContain('/a.js');
      },
    );
  });

  it('skips files with no map beside them rather than failing', async () => {
    const dir = await fixture({
      'a.js': 'const a=1;',
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
      'vendor.js': 'const v=1;',
    });

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        const summary = await upload(
          dir,
          { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
          silent,
        );

        expect(summary.skipped).toBe(1);
        expect(seen[0]!.files).toHaveLength(1);
      },
    );
  });
});

describe('what the summary has to say', () => {
  /**
   * Two byte-identical chunks emitted under different names derive the same id, and the server
   * keeps one artifact per debug id — so sending both means the second silently replaces the
   * first, and the url stored for that id is whichever request happened to land last.
   */
  it('sends one map per debug id, and names the chunk it dropped', async () => {
    const chunk = 'const a=1;\n';
    const dir = await fixture({
      'a.js': chunk,
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
      'copy.js': chunk,
      'copy.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    });

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        const warnings: string[] = [];
        const summary = await upload(
          dir,
          { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
          silent,
          (line) => warnings.push(line),
        );

        expect(summary.duplicates).toBe(1);
        expect(seen[0]!.files).toHaveLength(1);
        expect(warnings.join('\n')).toContain('same debug id');
      },
    );
  });

  it('says loudly when there are chunks and no maps at all', async () => {
    // The single most common way this does nothing useful, and it used to say nothing: a bundler
    // with source maps switched off produces a directory of chunks and not one map, which looks
    // from here exactly like an empty directory.
    const dir = await fixture({ 'a.js': 'const a=1;\n', 'b.js': 'const b=2;\n' });

    await withServer(
      () => ({ status: 201, body: { stored: 0 } }),
      async (host, seen) => {
        const warnings: string[] = [];
        await upload(dir, { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent, (line) =>
          warnings.push(line),
        );

        expect(seen).toHaveLength(0);
        expect(warnings.join('\n')).toContain('and no source maps');
        expect(warnings.join('\n')).toContain('devtool');
      },
    );
  });

  it('skips a map that resolves nothing, rather than filing an id no frame reports', async () => {
    // Vite emits one of these per HTML entry, for a facade chunk that is nothing but imports.
    const dir = await fixture({
      'entry.js': 'import "./a.js";\n',
      'entry.js.map': '{"version":3,"sources":[],"mappings":""}',
      'a.js': 'const a=1;\n',
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    });

    await withServer(
      () => ({ status: 201, body: { stored: 1, artifacts: [] } }),
      async (host, seen) => {
        const summary = await upload(
          dir,
          { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
          silent,
          silent,
        );

        expect(summary.empty).toBe(1);
        expect(seen[0]!.files).toHaveLength(1);
      },
    );
  });

  it('prints a summary even when the upload throws', async () => {
    // A build step whose last output is a stack trace tells you it failed and not what it had
    // managed to do first.
    const dir = await fixture({
      'a.js': 'const a=1;\n',
      'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    });

    await withServer(
      () => ({ status: 403, body: { error: 'cli_scope_required' } }),
      async (host) => {
        const lines: string[] = [];
        await upload(
          dir,
          { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
          (line) => lines.push(line),
          silent,
        ).catch(() => undefined);

        expect(lines.join('\n')).toContain('Source maps:');
      },
    );
  });
});

describe('a redeploy of an unchanged build', () => {
  it(
    'asks what the server already has and sends nothing when it has all of it',
    async () => {
      const held: string[] = [];

      await withServer(
        () => ({ status: 201, body: { stored: 1 } }),
        async (host, seen) => {
          const dir = await fixture({
            'app.js': 'console.log(1)\n//# sourceMappingURL=app.js.map',
            'app.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
          });
          const options = { host, key: 'vnk_pk_cli', release: 'r1', urlPrefix: '~/', dryRun: false };

          const first = await upload(dir, options, silent, silent);
          expect(first.uploaded).toBe(1);
          expect(seen).toHaveLength(1);

          // Exactly the bytes the server stored, which is what it would answer the pre-flight with.
          held.push(createHash('sha256').update(seen[0]!.files[0]!).digest('hex'));

          const second = await upload(dir, options, silent, silent);
          expect(second.uploaded).toBe(0);
          expect(second.alreadyStored).toBe(1);
          expect(seen).toHaveLength(1);
        },
        held,
      );
    },
  );

  it(
    'still uploads when the pre-flight is unavailable, because a missed skip is cheaper than a missing map',
    async () => {
      let server: Server | undefined;
      try {
        server = createServer((request, response) => {
          request.resume();
          request.on('end', () => {
            if ((request.url ?? '').endsWith('/check')) {
              response.writeHead(404);
              response.end('no such route');

              return;
            }
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ stored: 1 }));
          });
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;

        const dir = await fixture({
          'app.js': 'console.log(1)\n//# sourceMappingURL=app.js.map',
          'app.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
        });

        const summary = await upload(
          dir,
          { host: `http://127.0.0.1:${port}`, key: 'vnk_pk_cli', release: 'r1', urlPrefix: '~/', dryRun: false },
          silent,
          silent,
        );

        expect(summary.uploaded).toBe(1);
        expect(summary.alreadyStored).toBe(0);
      } finally {
        if (server !== undefined) await shutdown(server);
      }
    },
  );
});

describe('an oversized map', () => {
  it(
    'is skipped with a warning, and the rest of the build still uploads',
    async () => {
      await withServer(
        () => ({ status: 201, body: { stored: 1 } }),
        async (host, seen) => {
          // Over the 20 MiB per-file ceiling once the debug id is written into it.
          const huge = `{"version":3,"sources":["big.ts"],"sourcesContent":["${'x'.repeat(21_000_000)}"],"mappings":"AAAA"}`;
          const dir = await fixture({
            'big.js': 'console.log(1)\n//# sourceMappingURL=big.js.map',
            'big.js.map': huge,
            'small.js': 'console.log(2)\n//# sourceMappingURL=small.js.map',
            'small.js.map': '{"version":3,"sources":["s.ts"],"mappings":"AAAA"}',
          });

          const warnings: string[] = [];
          const summary = await upload(
            dir,
            { host, key: 'vnk_pk_cli', release: 'r1', urlPrefix: '~/', dryRun: false },
            silent,
            (line) => warnings.push(line),
          );

          expect(summary.oversized).toBe(1);
          expect(summary.uploaded).toBe(1);
          expect(seen[0]!.files).toHaveLength(1);
          expect(warnings.join('\n')).toContain('big.js.map');
        },
      );
    },
    30_000,
  );
});

describe('rejections are actionable', () => {
  const dir = () => fixture({ 'a.js': 'const a=1;', 'a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}' });

  it('explains that upload needs the cli scope, not a write key', async () => {
    await withServer(
      () => ({ status: 403, body: { error: 'cli_scope_required' } }),
      async (host) => {
        await expect(
          upload(await dir(), { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent),
        ).rejects.toMatchObject({
          code: 'cli_scope_required',
          // The distinction that saves an afternoon: the key is fine, the scope is not.
          hint: expect.stringContaining('write key is not enough'),
        });
      },
    );
  });

  it('reports a full quota as a plan limit, not a stack trace', async () => {
    await withServer(
      () => ({
        status: 413,
        body: { error: 'quota_exceeded', quota_bytes: 52_428_800, used_bytes: 52_000_000 },
      }),
      async (host) => {
        const error = await upload(
          await dir(),
          { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
          silent,
        ).catch((e: unknown) => e as UploadError);

        expect(error).toBeInstanceOf(UploadError);
        expect((error as UploadError).message).toContain('50.0 MB');
        expect((error as UploadError).hint).toContain('upgrade');
      },
    );
  });

  it('names the key as the problem on a 401', async () => {
    await withServer(
      () => ({ status: 401, body: { error: 'invalid_api_key' } }),
      async (host) => {
        await expect(
          upload(await dir(), { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent),
        ).rejects.toMatchObject({ hint: expect.stringContaining('--key') });
      },
    );
  });
});

describe('url derivation', () => {
  it('joins a prefix and a relative path without doubling slashes', () => {
    expect(toUrl('/assets/', 'app.js')).toBe('/assets/app.js');
    expect(toUrl('/assets', 'app.js')).toBe('/assets/app.js');
    expect(toUrl('/assets/', '/app.js')).toBe('/assets/app.js');
  });

  /**
   * The server strips the query, the fragment, then the scheme and host before comparing — and
   * applies the same to a runtime frame. So a full-origin prefix and a bare path are equivalent,
   * which is what makes `--url-prefix` forgiving.
   */
  it('normalises the way the server does', () => {
    expect(normalise('https://cdn.example.com/assets/app.js?v=2')).toBe('/assets/app.js');
    expect(normalise('~/assets/app.js')).toBe('/assets/app.js');
    expect(normalise('/assets/app.js#x')).toBe('/assets/app.js');
    expect(normalise('assets/app.js')).toBe('/assets/app.js');
  });
});

describe('batching', () => {
  it('splits by bytes, because maps vary by orders of magnitude', () => {
    const big = (bytes: number) => ({
      entry: { name: 'm', url: 'u', debugId: 'd', bytes, sha256: `${bytes}`, mapSha256: `${bytes}`, injected: true },
    });

    // Three 25 MB maps cannot share one request, whatever the ceiling.
    const batches = batch([big(26_000_000), big(26_000_000), big(26_000_000)]);

    expect(batches.length).toBeGreaterThan(1);
    for (const group of batches) {
      const total = group.reduce((sum, item) => sum + item.entry.bytes, 0);
      expect(total).toBeLessThanOrEqual(62_914_560);
    }
  });

  it('stays under a stock post_max_size when the server publishes no limits', () => {
    const map = (bytes: number, n: number) => ({
      entry: { name: `m${n}`, url: `u${n}`, debugId: `d${n}`, bytes, sha256: `${n}`, mapSha256: `${n}`, injected: true },
    });

    // Ten 1 MB maps: fine for the 60 MiB protocol ceiling, fatal past PHP's default 8M
    // post_max_size (the body is swallowed and the server reports missing_release). An ingest
    // that publishes no limits is old enough that the default is the likely truth.
    const batches = batch(Array.from({ length: 10 }, (_, i) => map(1_000_000, i)));

    expect(batches.length).toBeGreaterThan(1);
    for (const group of batches) {
      const total = group.reduce((sum, item) => sum + item.entry.bytes, 0);
      expect(total).toBeLessThanOrEqual(6_000_000);
    }
    expect(batches.flat()).toHaveLength(10);
  });

  it('uses the server\'s own figure when it publishes one', () => {
    const map = (bytes: number, n: number) => ({
      entry: { name: `m${n}`, url: `u${n}`, debugId: `d${n}`, bytes, sha256: `${n}`, mapSha256: `${n}`, injected: true },
    });
    const items = Array.from({ length: 10 }, (_, i) => map(1_000_000, i));

    const generous = batch(items, {
      maxFileBytes: 20_971_520,
      maxPartBytes: 20_971_520,
      maxRequestBytes: 62_914_560,
      recommendedBatchBytes: 16_777_216,
      concurrency: 4,
      compression: ['gzip'],
    });
    expect(generous).toHaveLength(1);

    // And a deployment whose PHP was never reconfigured says so, rather than letting the client
    // discover it as a dropped body.
    const cramped = batch(items, {
      maxFileBytes: 2_097_152,
      maxPartBytes: 2_097_152,
      maxRequestBytes: 8_388_608,
      recommendedBatchBytes: 7_549_747,
      concurrency: 4,
      compression: [],
    });
    expect(cramped.length).toBeGreaterThan(1);
    for (const group of cramped) {
      expect(group.reduce((sum, item) => sum + item.entry.bytes, 0)).toBeLessThanOrEqual(7_549_747);
    }
  });

  it('keeps everything, never silently drops', () => {
    const item = (n: number) => ({
      entry: { name: `${n}`, url: 'u', debugId: 'd', bytes: 100, sha256: `${n}`, mapSha256: `${n}`, injected: true },
    });
    const items = Array.from({ length: 50 }, (_, i) => item(i));

    expect(batch(items).flat()).toHaveLength(50);
  });
});

describe('mb', () => {
  it('formats for humans', () => {
    expect(mb(20_971_520)).toBe('20.0 MB');
  });
});

describe('a transient failure', () => {
  it('is retried, and the deploy step survives one 503', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-retry-'));
    await writeFile(join(dir, 'app.js'), 'x();\n//# sourceMappingURL=app.js.map\n');
    await writeFile(join(dir, 'app.js.map'), JSON.stringify({ version: 3, sources: ['app.ts'], mappings: 'AAAA' }));

    let calls = 0;
    await withServer(
      () => {
        calls += 1;

        return calls === 1
          ? { status: 503, body: { error: 'storage_unavailable' } }
          : { status: 201, body: { stored: 1, artifacts: [] } };
      },
      async (host) => {
        const summary = await upload(dir, { host, key: 'vnk_sk_cli', release: 'r1', urlPrefix: '~/', dryRun: false, timeoutMs: 5_000 }, () => {});

        expect(summary.stored).toBe(1);
        expect(calls).toBe(2);
      },
    );
  });

  it('gives up after three attempts with a message that names the count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-retry-'));
    await writeFile(join(dir, 'app.js'), 'x();\n//# sourceMappingURL=app.js.map\n');
    await writeFile(join(dir, 'app.js.map'), JSON.stringify({ version: 3, sources: ['app.ts'], mappings: 'AAAA' }));

    let calls = 0;
    await withServer(
      () => {
        calls += 1;

        return { status: 502, body: {} };
      },
      async (host) => {
        await expect(
          upload(dir, { host, key: 'vnk_sk_cli', release: 'r1', urlPrefix: '~/', dryRun: false, timeoutMs: 5_000 }, () => {}),
        ).rejects.toBeInstanceOf(UploadError);
        expect(calls).toBe(3);
      },
    );
  }, 30_000);
});
