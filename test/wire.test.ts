import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { upload } from '../src/commands/upload.js';
import { backoffMs, proxyFor, retriable, RETRIABLE_STATUS, userAgent } from '../src/http.js';
import { multipart } from '../src/multipart.js';
import { rewrite } from '../src/upload.js';

const MAP = '{"version":3,"sources":["a.ts"],"sourcesContent":["const a = 1;"],"mappings":"AAAA"}';

interface Seen {
  contentType: string;
  userAgent: string;
  header: string;
  parts: Array<{ name: string; filename?: string; body: Buffer }>;
}

/**
 * A server that keeps the RAW bytes of each part.
 *
 * A gzipped part is only gzip bytes — `Content-Encoding` does not survive multipart parsing — so
 * a test that decodes the body as text cannot tell whether compression happened at all.
 */
async function ingest(
  limits: unknown,
  run: (host: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/check')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(limits === null ? { stored: [] } : { stored: [], limits }));

        return;
      }

      const contentType = String(request.headers['content-type'] ?? '');
      seen.push({
        contentType,
        userAgent: String(request.headers['user-agent'] ?? ''),
        header: String(request.headers['x-example'] ?? ''),
        parts: split(Buffer.concat(chunks), /boundary=(.+)$/.exec(contentType)?.[1] ?? ''),
      });

      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ stored: 1, artifacts: [] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function split(body: Buffer, boundary: string): Seen['parts'] {
  const parts: Seen['parts'] = [];
  const separator = Buffer.from(`--${boundary}`);
  let index = body.indexOf(separator);

  while (index !== -1) {
    const next = body.indexOf(separator, index + separator.length);
    if (next === -1) break;

    const section = body.subarray(index + separator.length, next);
    const blank = section.indexOf('\r\n\r\n');
    if (blank !== -1) {
      const headers = section.subarray(0, blank).toString('utf8');
      const name = /name="([^"]+)"/.exec(headers)?.[1];
      if (name !== undefined) {
        parts.push({
          name,
          ...(/filename="([^"]+)"/.exec(headers)?.[1] === undefined
            ? {}
            : { filename: /filename="([^"]+)"/.exec(headers)![1]! }),
          // Minus the CRLF that closes the part.
          body: section.subarray(blank + 4, section.length - 2),
        });
      }
    }

    index = next;
  }

  return parts;
}

async function build(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-wire-'));
  await writeFile(join(dir, 'app.js'), 'const a=1;\n//# sourceMappingURL=app.js.map\n', 'utf8');
  await writeFile(join(dir, 'app.js.map'), MAP, 'utf8');

  return dir;
}

const FULL = {
  maxFileBytes: 20_971_520,
  maxPartBytes: 20_971_520,
  maxRequestBytes: 62_914_560,
  maxBatchBytes: 16_777_216,
  concurrency: 4,
  compression: ['gzip'],
};

const silent = (): void => {};

describe('what actually goes on the wire', () => {
  it('gzips each part when the server says it accepts that', async () => {
    const dir = await build();

    await ingest(FULL, async (host, seen) => {
      await upload(dir, { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent, silent);

      const file = seen[0]!.parts.find((part) => part.name === 'files[]')!;
      // Gzip's magic number. The server detects a compressed part exactly this way, because
      // Content-Encoding is not carried through multipart parsing.
      expect(file.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(JSON.parse(gunzipSync(file.body).toString('utf8'))).toMatchObject({ version: 3 });
      expect(file.filename).toBe('app.js.map');
    });
  });

  it('sends plain bytes when the server does not advertise compression', async () => {
    const dir = await build();

    await ingest({ ...FULL, compression: [] }, async (host, seen) => {
      await upload(dir, { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent, silent);

      const file = seen[0]!.parts.find((part) => part.name === 'files[]')!;
      expect(JSON.parse(file.body.toString('utf8'))).toMatchObject({ version: 3 });
    });
  });

  it('refuses a part the server says it cannot take, and says how big it will take', async () => {
    const dir = await build();

    await ingest({ ...FULL, maxPartBytes: 10 }, async (host, seen) => {
      const warnings: string[] = [];
      const summary = await upload(
        dir,
        { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false },
        silent,
        (line) => warnings.push(line),
      );

      expect(seen).toHaveLength(0);
      expect(summary.oversized).toBe(1);
      expect(warnings.join('\n')).toContain('this server accepts');
    });
  });

  it('identifies itself, and carries an extra header when told to', async () => {
    const dir = await build();

    await ingest(FULL, async (host, seen) => {
      await upload(
        dir,
        {
          host,
          key: 'k',
          release: 'r',
          urlPrefix: '~/',
          dryRun: false,
          plugin: 'vite-plugin/0.1.0',
          headers: { 'X-Example': 'yes' },
        },
        silent,
        silent,
      );

      expect(seen[0]!.userAgent).toContain('vinktar-cli/');
      expect(seen[0]!.userAgent).toContain('vite-plugin/0.1.0');
      expect(seen[0]!.header).toBe('yes');
    });
  });

  it('keeps the three arrays paired by index', async () => {
    const dir = await build();
    await writeFile(join(dir, 'b.js'), 'const b=2;\n//# sourceMappingURL=b.js.map\n', 'utf8');
    await writeFile(join(dir, 'b.js.map'), MAP.replace('a.ts', 'b.ts'), 'utf8');

    await ingest({ ...FULL, compression: [] }, async (host, seen) => {
      await upload(dir, { host, key: 'k', release: 'r', urlPrefix: '~/', dryRun: false }, silent, silent);

      const files = seen[0]!.parts.filter((part) => part.name === 'files[]');
      const urls = seen[0]!.parts.filter((part) => part.name === 'urls[]');
      const ids = seen[0]!.parts.filter((part) => part.name === 'debug_ids[]');

      expect(files).toHaveLength(2);
      expect(urls.map((part) => part.body.toString('utf8'))).toEqual(['~/app.js', '~/b.js']);
      for (const [index, file] of files.entries()) {
        expect(JSON.parse(file.body.toString('utf8')).debugId).toBe(ids[index]!.body.toString('utf8'));
      }
    });
  });
});

describe('building the multipart body', () => {
  it('does not let a filename close the field early', () => {
    const { body } = multipart([{ name: 'files[]', value: 'x', filename: 'a"b\r\nc.map' }]);

    expect(body.toString('utf8')).toContain('filename="a%22bc.map"');
  });

  it('puts exact bytes in a part, not a re-encoded string', () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff]);
    const { body } = multipart([{ name: 'files[]', value: bytes, filename: 'a.map' }]);

    expect(body.includes(bytes)).toBe(true);
  });
});

describe('tidying sources for the server', () => {
  it('strips the bundler protocol prefix nothing can open', () => {
    const out = JSON.parse(rewrite('{"version":3,"sources":["webpack:///./src/App.tsx"]}'));

    expect(out.sources).toEqual(['src/App.tsx']);
  });

  it('makes a build-machine path relative to the build root', () => {
    // `/home/runner/work/acme/acme/src/App.tsx` is both noise and the CI layout, and the ingest
    // never asked for either.
    const out = JSON.parse(rewrite('{"version":3,"sources":["/build/src/App.tsx"]}', '/build'));

    expect(out.sources).toEqual(['src/App.tsx']);
  });

  it('leaves a path that is not inside the root alone, rather than spelling it worse', () => {
    const out = JSON.parse(rewrite('{"version":3,"sources":["/opt/lib/x.js"]}', '/build'));

    expect(out.sources).toEqual(['/opt/lib/x.js']);
  });

  it('returns the input untouched when it is not a map', () => {
    expect(rewrite('not json')).toBe('not json');
    expect(rewrite('[]')).toBe('[]');
  });
});

describe('the retry policy', () => {
  it('retries what a proxy or a restarting app produces, and nothing a 4xx means', () => {
    expect([...RETRIABLE_STATUS].sort((a, b) => a - b)).toEqual([429, 502, 503, 504, 507, 524]);
    expect(RETRIABLE_STATUS.has(400)).toBe(false);
    expect(RETRIABLE_STATUS.has(403)).toBe(false);
  });

  it('retries a name that does not resolve only for the default host', () => {
    // A self-hosted URL that does not resolve is a typo, and retrying a typo three times with
    // backoff turns a one-second error into a ten-second one and teaches nobody anything.
    const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });

    expect(retriable(error, true)).toBe(true);
    expect(retriable(error, false)).toBe(false);
  });

  it('honours Retry-After, capped, because a proxy may send an hour', () => {
    expect(backoffMs(0, '5')).toBe(5_000);
    expect(backoffMs(0, '3600')).toBe(60_000);
    expect(backoffMs(0, null)).toBeGreaterThanOrEqual(1_000);
  });

  it('names itself in a way an ingest log can tell apart', () => {
    expect(userAgent()).toMatch(/^vinktar-cli\/\d+\.\d+\.\d+ \(node\//);
    expect(userAgent('webpack-plugin/1.0.0')).toContain('webpack-plugin/1.0.0');
  });
});

describe('choosing a proxy', () => {
  it('uses HTTPS_PROXY for an https host, lower case winning', () => {
    expect(proxyFor('https://in.vinktar.com', { https_proxy: 'http://a:8080', HTTPS_PROXY: 'http://b:8080' })?.host)
      .toBe('a:8080');
  });

  it('adds a scheme to a bare host:port, which is how people write it', () => {
    expect(proxyFor('https://in.vinktar.com', { HTTPS_PROXY: 'proxy.corp:3128' })?.protocol).toBe('http:');
  });

  it('honours NO_PROXY, including a leading dot and a bare wildcard', () => {
    expect(proxyFor('https://in.vinktar.com', { HTTPS_PROXY: 'http://p:1', NO_PROXY: '.vinktar.com' })).toBeNull();
    expect(proxyFor('https://in.vinktar.com', { HTTPS_PROXY: 'http://p:1', NO_PROXY: '*' })).toBeNull();
    expect(proxyFor('https://in.vinktar.com', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'other.com' })).not.toBeNull();
  });

  it('is null when nothing is configured, so the ordinary path never changes', () => {
    expect(proxyFor('https://in.vinktar.com', {})).toBeNull();
  });
});
