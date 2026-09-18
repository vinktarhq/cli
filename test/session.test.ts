import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectRelease, disabled, environmentWarnings, session } from '../src/bundler/core.js';
import { vinktar } from '../src/vite.js';
import { vinktarRollup } from '../src/bundler/rollup.js';

const MAP = '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}';

async function build(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vinktar-session-'));
  const all: Record<string, string> = {
    'app.js': 'x();\n//# sourceMappingURL=app.js.map\n',
    'app.js.map': MAP,
    ...files,
  };

  for (const [name, content] of Object.entries(all)) await writeFile(join(dir, name), content, 'utf8');

  return dir;
}

async function ingest(
  status = 201,
  error = 'boom',
): Promise<{ host: string; requests: number; close(): Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/check')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ stored: [] }));

        return;
      }
      requests += 1;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 201 ? { stored: 1, artifacts: [] } : { error }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  return {
    host: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Without this, `close()` waits out the client's idle keep-alive socket — 5 s on Node 18,
        // which is longer than the test timeout. Node 20 closes idle connections for you.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const warnings: string[] = [];
const logs: string[] = [];

function capture(): void {
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void warnings.push(line));
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
}

afterEach(() => {
  vi.restoreAllMocks();
  warnings.length = 0;
  logs.length = 0;
});

describe('what a plugin does after the build', () => {
  it('uploads and then removes the maps, and unpoints the chunk that named one', async () => {
    const server = await ingest();
    const dir = await build();
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true }, {});
      await run.upload(dir);
      await run.cleanup();
    } finally {
      await server.close();
    }

    expect(server.requests).toBe(1);
    expect(await readdir(dir)).toEqual(['app.js']);
    // A comment pointing at a file that is gone is a 404 in every devtools session, and reads as
    // a broken build.
    expect(await readFile(join(dir, 'app.js'), 'utf8')).not.toContain('sourceMappingURL');
  });

  /**
   * The case this exists for: a CI job whose key secret is unset or empty. Skipping deletion
   * there leaves the build output full of source maps, served to anyone who asks for them.
   */
  it('still removes the maps when there is no key, and says what that costs', async () => {
    const dir = await build();
    capture();

    const run = session({ silent: true }, {});
    await run.upload(dir);
    await run.cleanup();

    expect(await readdir(dir)).toEqual(['app.js']);
    expect(warnings.join('\n')).toContain('VINKTAR_CLI_KEY is not set');
    expect(warnings.join('\n')).toContain('cannot be symbolicated');
  });

  it('removes a .css.map too, which is the stylesheet sources by another name', async () => {
    const dir = await build({ 'app.css': 'a{}', 'app.css.map': MAP });
    capture();

    const run = session({ silent: true }, {});
    await run.upload(dir);
    await run.cleanup();

    expect((await readdir(dir)).sort()).toEqual(['app.css', 'app.js']);
  });

  it('leaves a map that changed after it was uploaded', async () => {
    // Turbopack rewrites files while later stages are still running, and a map deleted there is
    // one the server never received.
    const server = await ingest();
    const dir = await build();
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true }, {});
      await run.upload(dir);
      await writeFile(join(dir, 'app.js.map'), '{"version":3,"sources":["b.ts"],"mappings":"AAAA"}', 'utf8');
      await run.cleanup();
    } finally {
      await server.close();
    }

    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
    expect(warnings.join('\n')).toContain('changed after it was uploaded');
  });

  it('keeps the maps when deletion is turned off', async () => {
    const dir = await build();
    capture();

    const run = session({ silent: true, deleteSourcemapsAfterUpload: false }, {});
    await run.upload(dir);
    await run.cleanup();

    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('does nothing at all when the whole feature is switched off', async () => {
    const dir = await build();
    capture();

    const run = session({ silent: true, uploadSourcemaps: false }, {});
    await run.upload(dir);
    await run.cleanup();

    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
    expect(warnings).toEqual([]);
  });
});

/**
 * The vendor being down, a revoked key, a checkout with no git: none of those is a reason for
 * somebody's deploy to stop. Every one of them warns, keeps the maps where the bundler put them,
 * and lets the build finish; `strict` is for a team that would rather it stopped.
 */
describe('when the upload fails', () => {
  const failing = async (
    options: Parameters<typeof session>[0],
    env: Record<string, string | undefined> = {},
    files: Record<string, string> = {},
  ): Promise<{ dir: string; requests: number; outcome: unknown }> => {
    const server = await ingest(500);
    const dir = await build(files);
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true, ...options }, env);
      const outcome = await run.upload(dir).then(
        () => null,
        (error: unknown) => error,
      );
      await run.cleanup();

      return { dir, requests: server.requests, outcome };
    } finally {
      await server.close();
    }
  };

  it('warns and lets the build finish when the server answers 500', async () => {
    const { outcome } = await failing({});

    expect(outcome).toBeNull();
    expect(warnings.join('\n')).toContain('source-map upload failed: Ingest rejected the upload (HTTP 500).');
  });

  it('leaves the maps where they are, and says that a deploy of that directory publishes them', async () => {
    const { dir } = await failing({});

    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
    expect(await readFile(join(dir, 'app.js'), 'utf8')).toContain('sourceMappingURL');
    expect(warnings.join('\n')).toContain('left in place');
    expect(warnings.join('\n')).toContain(dir);
    expect(warnings.join('\n')).toContain('strict');
  });

  it('does not mention the maps when they were being kept anyway', async () => {
    const { dir } = await failing({ deleteSourcemapsAfterUpload: false });

    expect(warnings.join('\n')).toContain('source-map upload failed');
    expect(warnings.join('\n')).not.toContain('left in place');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('warns with the hint when the key is refused', async () => {
    const server = await ingest(401, 'invalid_api_key');
    const dir = await build();
    capture();

    try {
      const run = session({ key: 'vnk_sk_revoked', host: server.host, release: 'r1', silent: true }, {});
      await run.upload(dir);
      await run.cleanup();
    } finally {
      await server.close();
    }

    expect(warnings.join('\n')).toContain('The write key was rejected.');
    expect(warnings.join('\n')).toContain('VINKTAR_CLI_KEY');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('warns when the host cannot be reached at all', async () => {
    const dir = await build();
    capture();

    // A port that was listening a moment ago and is not now. One attempt, so the test does not
    // sit through the backoff.
    const gone = await ingest();
    await gone.close();
    const run = session({ key: 'vnk_sk_cli', host: gone.host, release: 'r1', silent: true, maxRetries: 1 }, {});
    await run.upload(dir);
    await run.cleanup();

    expect(warnings.join('\n')).toContain(`Could not reach ${gone.host}`);
    expect(warnings.join('\n')).toContain('ECONNREFUSED');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('warns about an empty release before any request, rather than relaying the server', async () => {
    const { dir, requests } = await failing({ release: ' ' });

    expect(requests).toBe(0);
    expect(warnings.join('\n')).toContain('source-map upload failed: There is no release');
    expect(warnings.join('\n')).toContain('VINKTAR_RELEASE');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('warns about a map that is not JSON', async () => {
    const { dir, outcome, requests } = await failing({}, {}, { 'app.js.map': 'not a source map' });

    expect(outcome).toBeNull();
    expect(requests).toBe(0);
    expect(warnings.join('\n')).toContain('source-map upload failed');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('warns about a directory it cannot read', async () => {
    const server = await ingest();
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true }, {});
      await run.upload(join(tmpdir(), 'vinktar-session-never-built'));
      await run.cleanup();
    } finally {
      await server.close();
    }

    expect(warnings.join('\n')).toContain('source-map upload failed');
  });

  it('still removes the maps of an output that did upload', async () => {
    // A client bundle that went up and an SSR bundle that did not: only the second one stays.
    const good = await ingest();
    const bad = await ingest(500);
    const client = await build();
    const ssr = await build();
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: good.host, release: 'r1', silent: true }, {});
      await run.upload(client);
      await session({ key: 'vnk_sk_cli', host: bad.host, release: 'r1', silent: true }, {}).upload(ssr);
      await run.cleanup();
    } finally {
      await good.close();
      await bad.close();
    }

    expect(await readdir(client)).toEqual(['app.js']);
    expect((await readdir(ssr)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('fails the build under strict, with the reason and the hint', async () => {
    const { dir, outcome } = await failing({ strict: true });

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('source-map upload failed: Ingest rejected the upload (HTTP 500).');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('reads strict from VINKTAR_STRICT, for a pipeline that cannot edit the config', async () => {
    expect((await failing({}, { VINKTAR_STRICT: '1' })).outcome).toBeInstanceOf(Error);
    expect((await failing({ strict: false }, { VINKTAR_STRICT: '1' })).outcome).toBeNull();
  });

  it('fails a strict build on an empty release and on a broken map too', async () => {
    expect((await failing({ strict: true, release: '' })).outcome).toBeInstanceOf(Error);
    expect((await failing({ strict: true }, {}, { 'app.js.map': 'not a source map' })).outcome).toBeInstanceOf(Error);
  });

  it('hands the error to errorHandler instead, when one is given, strict or not', async () => {
    const seen: Error[] = [];
    const { dir, outcome } = await failing({ strict: true, errorHandler: (e) => void seen.push(e) });

    expect(outcome).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toContain('HTTP 500');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  });

  it('lets errorHandler fail the build by throwing', async () => {
    const { outcome } = await failing({
      errorHandler: (error) => {
        throw error;
      },
    });

    expect(outcome).toBeInstanceOf(Error);
  });
});

describe('request shaping from a plugin', () => {
  it('passes the deadline through, so a server that never answers cannot hold the build', async () => {
    const server: Server = createServer((request) => void request.resume());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = await build();
    capture();

    const started = Date.now();
    try {
      const run = session(
        {
          key: 'vnk_sk_cli',
          host: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          release: 'r1',
          silent: true,
          deadlineMs: 200,
        },
        {},
      );
      await run.upload(dir);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(warnings.join('\n')).toContain('did not finish within');
  });
});

describe('being switched off', () => {
  it('is a no-op plugin, not a flag threaded through every hook', () => {
    // A Vite config is reused by vitest and Storybook, and both would otherwise pay for loadEnv,
    // a `git rev-parse` and a walk of a directory they never built.
    expect(disabled({ disable: true }, {})).toBe(true);
    expect(disabled({}, { VINKTAR_DISABLE: '1' })).toBe(true);
    expect(disabled({}, { VINKTAR_DISABLE: 'false' })).toBe(false);
    expect(disabled({}, {})).toBe(false);
  });

  it('stamps nothing when disabled', () => {
    const plugin = vinktarRollup({ disable: true });

    expect(plugin.renderChunk.handler('const a = 1;\n', { fileName: 'a.js' })).toBeNull();
  });

  it('leaves the build config alone when disabled', async () => {
    const plugin = vinktar({ disable: true });

    expect(await plugin.config({}, { command: 'build', mode: 'production' })).toEqual({ define: {} });
  });

  it('uploads without stamping when only injection is off', async () => {
    // For a build under a strict CSP, or with subresource integrity computed elsewhere, where
    // nothing may modify a chunk after another tool has hashed it.
    const plugin = vinktarRollup({ injectDebugIds: false });

    expect(plugin.renderChunk.handler('const a = 1;\n', { fileName: 'a.js' })).toBeNull();
  });
});

describe('an environment that will quietly break this', () => {
  it('names Turborepo, which passes only the environment a task declares', () => {
    const warnings = environmentWarnings('/app/dist', { TURBO_HASH: 'abc' });

    expect(warnings.join('\n')).toContain('passThroughEnv');
  });

  it('says nothing about Turborepo once the key is actually reaching the build', () => {
    expect(environmentWarnings('/app/dist', { TURBO_HASH: 'abc', VINKTAR_CLI_KEY: 'vnk_sk_a' })).toEqual([]);
  });

  it('names an output directory inside node_modules, whose files are never served', () => {
    const warnings = environmentWarnings('/app/node_modules/.cache/build', {});

    expect(warnings.join('\n')).toContain('node_modules');
  });
});

describe('the release', () => {
  it('prefers an explicit value over everything, trimmed', () => {
    expect(detectRelease({ VINKTAR_RELEASE: '  v1.2.3\n', GITHUB_SHA: 'a'.repeat(40) })).toBe('v1.2.3');
  });

  /**
   * On `pull_request`, `GITHUB_SHA` is a synthetic merge commit that exists only inside the
   * runner: it is in nobody's history, so a release named after it matches nothing the deployed
   * application will ever report.
   */
  it('reads the head sha out of the event payload on a GitHub pull request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-event-'));
    const path = join(dir, 'event.json');
    await writeFile(path, JSON.stringify({ pull_request: { head: { sha: 'b'.repeat(40) } } }), 'utf8');

    expect(
      detectRelease({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: path,
        GITHUB_SHA: 'a'.repeat(40),
      }),
    ).toBe('b'.repeat(40));
  });

  it('falls back to the CI variable, then to git, and never to a shortened sha', () => {
    expect(detectRelease({ CI_COMMIT_SHA: 'c'.repeat(40) })).toBe('c'.repeat(40));
    expect(detectRelease({})).toMatch(/^[0-9a-f]{40}$/);
  });
});
