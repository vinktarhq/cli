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

async function ingest(status = 201): Promise<{ host: string; requests: number; close(): Promise<void> }> {
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
      response.end(JSON.stringify(status === 201 ? { stored: 1, artifacts: [] } : { error: 'boom' }));
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

describe('when the upload fails', () => {
  it('fails the build, because the maps were about to be deleted', async () => {
    const server = await ingest(500);
    const dir = await build();
    capture();

    try {
      const run = session({ key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true }, {});
      await expect(run.upload(dir)).rejects.toThrow(/could never be symbolicated/);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('only warns when the maps are being kept, because a later upload still resolves them', async () => {
    const server = await ingest(500);
    const dir = await build();
    capture();

    try {
      const run = session(
        { key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true, deleteSourcemapsAfterUpload: false },
        {},
      );
      await run.upload(dir);
    } finally {
      await server.close();
    }

    expect(warnings.join('\n')).toContain('source-map upload failed');
    expect((await readdir(dir)).sort()).toEqual(['app.js', 'app.js.map']);
  }, 30_000);

  it('hands the error to errorHandler instead, when one is given', async () => {
    const server = await ingest(500);
    const dir = await build();
    capture();
    const seen: Error[] = [];

    try {
      const run = session(
        { key: 'vnk_sk_cli', host: server.host, release: 'r1', silent: true, errorHandler: (e) => void seen.push(e) },
        {},
      );
      await run.upload(dir);
    } finally {
      await server.close();
    }

    expect(seen).toHaveLength(1);
  }, 30_000);
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
