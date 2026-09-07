import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { VERSION, parse, run } from '../src/cli.js';
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
    const code = await run(['sourcemaps', 'upload', './dist', '--key', 'k', '--release='], out.write, out.write);

    expect(code).toBe(1);
    expect(out.lines.join('\n')).toContain('--release is empty');
  });

  it('takes the release from $VINKTAR_RELEASE when the flag is omitted', async () => {
    process.env['VINKTAR_RELEASE'] = 'r-from-env';
    try {
      const out = capture();
      // A nonexistent directory: past the release check, the upload fails on discovery instead —
      // proving the env release was accepted.
      const code = await run(['sourcemaps', 'upload', './definitely-missing', '--key', 'k'], out.write, out.write);

      expect(code).toBe(1);
      expect(out.lines.join('\n')).not.toContain('Missing a release');
    } finally {
      delete process.env['VINKTAR_RELEASE'];
    }
  });

  it('refuses to upload without a key', async () => {
    const out = capture();
    const code = await run(['sourcemaps', 'upload', './dist', '--release', 'r'], out.write, out.write);

    expect(code).toBe(1);
    expect(out.lines.join('\n')).toContain('VINKTAR_KEY');
  });

  it('rejects an unknown command rather than doing something surprising', async () => {
    const out = capture();

    expect(await run(['deploy'], out.write, out.write)).toBe(1);
    expect(out.lines.join('\n')).toContain('Unknown command');
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
