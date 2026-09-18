import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VERSION, escaped, parse, run, streamFailed } from '../src/cli.js';
import {
  CONSERVATIVE_BATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_NAME_BYTES,
  MAX_REQUEST_BYTES,
  RECOMMENDED_BATCH_BYTES,
} from '../src/limits.js';

describe('argument parsing', () => {
  it('reads both --flag value and --flag=value', () => {
    const a = parse(['sourcemaps', 'upload', './dist', '--release', 'r1']);
    const b = parse(['sourcemaps', 'upload', './dist', '--release=r1']);

    expect(a.flags.get('release')).toBe('r1');
    expect(b.flags.get('release')).toBe('r1');
    expect(a.positional).toEqual(['sourcemaps', 'upload', './dist']);
  });

  it('treats a flag followed by another flag as a boolean', () => {
    // Otherwise `--dry-run --release x` would set dry-run to "--release".
    const args = parse(['--dry-run', '--release', 'r1']);

    expect(args.flags.get('dry-run')).toBe(true);
    expect(args.flags.get('release')).toBe('r1');
  });

  it('handles a trailing bare flag', () => {
    expect(parse(['x', '--dry-run']).flags.get('dry-run')).toBe(true);
  });

  it('never lets a switch eat the directory', () => {
    // The natural order. It used to set dry-run to "./dist" and then report a missing directory.
    const args = parse(['sourcemaps', 'upload', '--dry-run', './dist', '--release', 'r1']);

    expect(args.flags.get('dry-run')).toBe(true);
    expect(args.positional).toEqual(['sourcemaps', 'upload', './dist']);
  });
});

describe('the command surface', () => {
  const capture = () => {
    const lines: string[] = [];

    return { lines, write: (line: string) => lines.push(line) };
  };

  it('prints the version, which used to be unreachable behind the usage branch', async () => {
    const out = capture();

    expect(await run(['--version'], out.write, out.write)).toBe(0);
    expect(out.lines).toEqual([VERSION]);
  });

  it('prefers VINKTAR_CLI_KEY and warns when only the public write key is set', async () => {
    const previous = { cli: process.env['VINKTAR_CLI_KEY'], shared: process.env['VINKTAR_KEY'] };
    const out = capture();
    try {
      delete process.env['VINKTAR_CLI_KEY'];
      process.env['VINKTAR_KEY'] = 'vnk_pk_public';
      // A missing release stops the run before any network, after the key was resolved.
      await run(['sourcemaps', 'upload', './nowhere'], out.write, out.write);
      expect(out.lines.join('\n')).toContain('looks like a public write key');
    } finally {
      if (previous.cli !== undefined) process.env['VINKTAR_CLI_KEY'] = previous.cli;
      if (previous.shared === undefined) delete process.env['VINKTAR_KEY'];
      else process.env['VINKTAR_KEY'] = previous.shared;
    }
  });

  it('prints usage and fails when called with nothing', async () => {
    const out = capture();
    const code = await run([], out.write, out.write);

    expect(code).toBe(1);
    expect(out.lines.join('\n')).toContain('Usage');
  });

  it('detects the release rather than demanding one, and says which it used', async () => {
    // A deploy script that already knows its commit should not have to say so twice — and the one
    // thing that must not happen quietly is a release nobody chose, because the SDK has to report
    // the same string for any of this to resolve.
    delete process.env['VINKTAR_RELEASE'];
    const out = capture();
    await run(['sourcemaps', 'upload', './definitely-missing', '--key', 'k'], out.write, out.write);

    expect(out.lines.join('\n')).toMatch(/Release not given; using [0-9a-f]{40}\./);
  });

  it('refuses an empty release rather than uploading under the name ""', async () => {
    // `--release "$TAG"` with an unset TAG is not "no release", it is a release named nothing —
    // and falling through to detection would hide the mistake behind a plausible commit sha.
    const out = capture();
    const code = await run(['sourcemaps', 'upload', './dist', '--key', 'k', '--release=', '--strict'], out.write, out.write);

    expect(code).toBe(1);
    expect(out.lines.join('\n')).toContain('--release is empty');
  });

  it('takes the release from $VINKTAR_RELEASE when the flag is omitted', async () => {
    process.env['VINKTAR_RELEASE'] = 'r-from-env';
    try {
      const out = capture();
      // A nonexistent directory: past the release check, the upload fails on discovery instead —
      // proving the env release was accepted.
      const code = await run(['sourcemaps', 'upload', './definitely-missing', '--key', 'k', '--strict'], out.write, out.write);

      expect(code).toBe(1);
      expect(out.lines.join('\n')).not.toContain('Missing a release');
    } finally {
      delete process.env['VINKTAR_RELEASE'];
    }
  });

  it('refuses to upload without a key', async () => {
    const out = capture();
    const code = await run(['sourcemaps', 'upload', './dist', '--release', 'r', '--strict'], out.write, out.write);

    expect(code).toBe(1);
    expect(out.lines.join('\n')).toContain('VINKTAR_KEY');
  });

  it('rejects an unknown command rather than doing something surprising', async () => {
    const out = capture();

    expect(await run(['deploy'], out.write, out.write)).toBe(1);
    expect(out.lines.join('\n')).toContain('Unknown command');
  });
});

/**
 * `sourcemaps upload` runs inside somebody's deploy, and the deploy is theirs. Whatever stops the
 * maps going up — the server, the key, the build directory — is said on stderr and costs an exit
 * code of 0, unless `--strict` asks for 1. A command that was WRITTEN wrong is different: that is a
 * typo in a CI script, it fails the same way on every run, and it should be found on the first.
 */
describe('what a failed upload costs the pipeline', () => {
  const NAMES = ['VINKTAR_CLI_KEY', 'VINKTAR_KEY', 'VINKTAR_STRICT', 'VINKTAR_ALLOW_FAILURE', 'VINKTAR_HOST'];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const build = async (map = '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}'): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-exit-'));
    await writeFile(join(dir, 'app.js'), 'x();\n//# sourceMappingURL=app.js.map\n', 'utf8');
    await writeFile(join(dir, 'app.js.map'), map, 'utf8');

    return dir;
  };

  /** Answers every upload with `status`; the pre-flight is always fine. */
  const against = async (
    status: number,
    body: unknown,
    argv: (host: string) => string[],
  ): Promise<{ code: number; out: string[]; err: string[] }> => {
    const server: Server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const check = (request.url ?? '').endsWith('/check');
        response.writeHead(check ? 200 : status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(check ? { stored: [] } : body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const out: string[] = [];
    const err: string[] = [];

    try {
      const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const code = await run(argv(host), (line) => out.push(line), (line) => err.push(line));

      return { code, out, err };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  const upload = (dir: string, host: string, ...more: string[]): string[] => [
    'sourcemaps', 'upload', dir, '--key', 'vnk_sk_cli', '--release', 'r1', '--host', host, '--quiet', ...more,
  ];

  it('exits 0 when the server refuses the upload, and says on stderr that nothing went up', async () => {
    const dir = await build();
    const { code, out, err } = await against(500, { error: 'boom' }, (host) => upload(dir, host));

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('WARNING: source maps were not uploaded.');
    expect(err.join('\n')).toContain('Ingest rejected the upload (HTTP 500).');
    expect(err.join('\n')).toContain('--strict');
    expect(out.join('\n')).not.toContain('not uploaded');
  });

  it('exits 1 for the same refusal under --strict, or VINKTAR_STRICT', async () => {
    const dir = await build();

    expect((await against(500, {}, (host) => upload(dir, host, '--strict'))).code).toBe(1);

    process.env['VINKTAR_STRICT'] = '1';
    expect((await against(500, {}, (host) => upload(dir, host))).code).toBe(1);
  });

  it('exits 0 for a refused key, with the hint', async () => {
    const dir = await build();
    const { code, err } = await against(401, { error: 'invalid_api_key' }, (host) => upload(dir, host));

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('The write key was rejected.');
    expect(err.join('\n')).toContain('VINKTAR_CLI_KEY');
  });

  it('still accepts --allow-failure, which is now what happens anyway', async () => {
    const dir = await build();

    expect((await against(500, {}, (host) => upload(dir, host, '--allow-failure'))).code).toBe(0);

    process.env['VINKTAR_ALLOW_FAILURE'] = '1';
    expect((await against(500, {}, (host) => upload(dir, host))).code).toBe(0);
  });

  it('lets --strict win over --allow-failure', async () => {
    const dir = await build();

    expect((await against(500, {}, (host) => upload(dir, host, '--allow-failure', '--strict'))).code).toBe(1);
  });

  it('exits 0 without a key, which is a secret that was never wired up', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['sourcemaps', 'upload', await build(), '--release', 'r1'], (l) => out.push(l), (l) => err.push(l));

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('WARNING: source maps were not uploaded.');
    expect(err.join('\n')).toContain('Missing a key');
  });

  it('exits 1 without a key under --strict', async () => {
    const lines: string[] = [];
    const code = await run(['sourcemaps', 'upload', await build(), '--release', 'r1', '--strict'], () => {}, (l) => lines.push(l));

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Missing a key');
  });

  it('exits 0 for a release that came out of the shell empty', async () => {
    const err: string[] = [];
    const code = await run(['sourcemaps', 'upload', await build(), '--key', 'k', '--release', ''], () => {}, (l) => err.push(l));

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('--release is empty');
  });

  it('exits 0 for a map that is not JSON, and 1 under --strict', async () => {
    const dir = await build('not a source map');
    const soft = await against(201, { stored: 1 }, (host) => upload(dir, host));

    expect(soft.code).toBe(0);
    expect(soft.err.join('\n')).toContain('WARNING: source maps were not uploaded.');

    expect((await against(201, { stored: 1 }, (host) => upload(dir, host, '--strict'))).code).toBe(1);
  });

  it('exits 0 for a directory that is not there, and for a --dotenv-file that is not', async () => {
    const err: string[] = [];
    const fail = (line: string): void => void err.push(line);

    expect(await run(['sourcemaps', 'upload', './definitely-missing', '--key', 'k', '--release', 'r1'], () => {}, fail)).toBe(0);
    expect(
      await run(['sourcemaps', 'upload', await build(), '--key', 'k', '--release', 'r1', '--dotenv-file', './no-such.env'], () => {}, fail),
    ).toBe(0);
    expect(err.join('\n')).toContain('No such file: ./no-such.env');
  });

  it('exits 0 when the build has no source maps at all, and 1 under --strict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-exit-'));
    await writeFile(join(dir, 'app.js'), 'x();\n', 'utf8');

    const soft = await against(201, {}, (host) => upload(dir, host));
    expect(soft.code).toBe(0);
    expect(soft.err.join('\n')).toContain('No source maps found');

    expect((await against(201, {}, (host) => upload(dir, host, '--strict'))).code).toBe(1);
  });

  it('exits 0 and says nothing alarming when the upload worked', async () => {
    const dir = await build();
    const { code, err } = await against(201, { stored: 1, artifacts: [] }, (host) => upload(dir, host));

    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  it('keeps 2 for --strict finding warnings in an upload that worked', async () => {
    const dir = await build();
    await writeFile(join(dir, 'bare.js'), 'y();\n', 'utf8');

    expect((await against(201, { stored: 1, artifacts: [] }, (host) => upload(dir, host, '--strict'))).code).toBe(2);
    expect((await against(201, { stored: 1, artifacts: [] }, (host) => upload(dir, host))).code).toBe(0);
  });

  it('leaves inject as it was: 1 when it cannot run, whatever strict says', async () => {
    expect(await run(['sourcemaps', 'inject', './definitely-missing'], () => {}, () => {})).toBe(1);
  });

  it('warns about an unknown flag on an upload and carries on', async () => {
    const dir = await build();
    const err: string[] = [];
    const code = await run(
      ['sourcemaps', 'upload', dir, '--key', 'k', '--release', 'r1', '--dry-run', '--strcit'],
      () => {},
      (line) => void err.push(line),
    );

    expect(code).toBe(0);
    expect(err.join('\n')).toContain('WARNING: unknown flag --strcit, ignored');
  });

  it('fails a command that was written wrong, strict or not', async () => {
    const dir = await build();
    const err: string[] = [];
    const fail = (line: string): void => void err.push(line);
    const base = ['sourcemaps', 'upload', dir, '--key', 'k', '--release', 'r1'];

    expect(await run(['sourcemaps', 'inject', dir, '--strcit'], () => {}, fail)).toBe(1);
    expect(err.join('\n')).toContain('Unknown flag --strcit');
    expect(await run([...base, '--strict', '--colour'], () => {}, fail)).toBe(1);

    expect(await run([...base, '--timeout', 'soon'], () => {}, fail)).toBe(1);
    expect(await run([...base, '--deadline', '0'], () => {}, fail)).toBe(1);
    expect(await run([...base, '--header', 'no-colon'], () => {}, fail)).toBe(1);
    expect(await run([...base, '--host', 'not a url'], () => {}, fail)).toBe(1);
    expect(await run(['sourcemaps', 'upload', '--key', 'k'], () => {}, fail)).toBe(1);
    expect(await run(['sourcemaps', 'uplaod', dir], () => {}, fail)).toBe(1);
    expect(await run(['status', '--projcet', 'web'], () => {}, fail)).toBe(1);
    expect(err.join('\n')).not.toContain('WARNING: source maps were not uploaded.');
  });

  it('says in --help what strict means and that it wins', async () => {
    const out: string[] = [];
    await run(['--help'], (line) => out.push(line), () => {});

    expect(out.join('\n')).toContain('--strict');
    expect(out.join('\n')).toContain('--deadline');
    expect(out.join('\n')).toMatch(/--allow-failure\s+Accepted and ignored/);
    expect(out.join('\n')).toContain('Exit codes');
  });
});

describe('the executable, when something escapes', () => {
  it('prints one line for an error nothing caught, and exits 1', () => {
    const lines: string[] = [];
    const target = { exitCode: undefined as number | undefined };

    escaped(new Error('disk full'), (line) => lines.push(line), target);

    expect(lines).toEqual(['vinktar: disk full']);
    expect(target.exitCode).toBe(1);
  });

  it('ignores a closed pipe, which is a reader that stopped reading', () => {
    const lines: string[] = [];
    const target = { exitCode: undefined as number | undefined };

    streamFailed(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), (line) => lines.push(line), target);

    expect(lines).toEqual([]);
    expect(target.exitCode).toBeUndefined();
  });

  it('reports any other stream error in one line instead of a stack, and exits 1', () => {
    const lines: string[] = [];
    const target = { exitCode: undefined as number | undefined };

    streamFailed(Object.assign(new Error('write EIO'), { code: 'EIO' }), (line) => lines.push(line), target);

    expect(lines).toEqual(['vinktar: could not write output: write EIO']);
    expect(target.exitCode).toBe(1);
  });
});

describe('the published contract', () => {
  it('keeps the version constant in step with the manifest', async () => {
    // The previous SDK set kept these in sync with a comment and was already out of sync.
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    expect(VERSION).toBe(manifest.version);
  });

  it('declares MIT where registries actually look', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    expect(manifest.license).toBe('MIT');
  });

  it('ships no runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    expect(manifest.dependencies ?? {}).toEqual({});
  });

  /**
   * The compiled-in limits are fallbacks used before the server has published its own, so they have
   * to be ordered sensibly among themselves. A batch bigger than a request, or a conservative
   * default above the recommended one, would send something the server is certain to refuse.
   */
  it('keeps the fallback limits internally consistent', () => {
    expect(CONSERVATIVE_BATCH_BYTES).toBeLessThan(RECOMMENDED_BATCH_BYTES);
    expect(RECOMMENDED_BATCH_BYTES).toBeLessThan(MAX_REQUEST_BYTES);
    expect(MAX_FILE_BYTES).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(MAX_NAME_BYTES).toBeGreaterThan(0);
  });
});
