import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parse } from '../src/cli.js';
import { resolve } from '../src/config.js';
import { loadDotEnv } from '../src/env.js';

function from(argv: string[], env: Record<string, string | undefined> = {}, dotenv?: Record<string, string>) {
  const { flags, repeated } = parse(argv);

  return resolve({ flags, repeated, env, ...(dotenv === undefined ? {} : { dotenv }) });
}

describe('precedence', () => {
  it('lets a flag beat the environment, and the environment beat a .env file', () => {
    expect(from(['--release', 'flag'], { VINKTAR_RELEASE: 'env' }, { VINKTAR_RELEASE: 'file' }).release).toBe('flag');
    expect(from([], { VINKTAR_RELEASE: 'env' }, { VINKTAR_RELEASE: 'file' }).release).toBe('env');
    expect(from([], {}, { VINKTAR_RELEASE: 'file' }).release).toBe('file');
  });

  /**
   * A repo `.env` must never outrank a secret the CI supplied. Getting this the other way round
   * means a committed file silently redirects a production upload, and nothing says so.
   */
  it('never lets a checked-in file redirect a CI-supplied key or host', () => {
    const config = from([], { VINKTAR_CLI_KEY: 'vnk_sk_ci', VINKTAR_HOST: 'https://in.example.test' }, {
      VINKTAR_CLI_KEY: 'vnk_sk_repo',
      VINKTAR_HOST: 'https://evil.example',
    });

    expect(config.key).toBe('vnk_sk_ci');
    expect(config.host).toBe('https://in.example.test');
  });

  it('prefers the cli key over the public one, and says so when only the public one is set', () => {
    expect(from([], { VINKTAR_CLI_KEY: 'vnk_sk_a', VINKTAR_KEY: 'vnk_pk_b' }).key).toBe('vnk_sk_a');

    const public_ = from([], { VINKTAR_KEY: 'vnk_pk_b' });
    expect(public_.key).toBe('vnk_pk_b');
    expect(public_.warnings.join('\n')).toContain('"cli" scope');
  });
});

describe('refusing a value rather than guessing', () => {
  /**
   * `VINKTAR_CLI_KEY=$(echo "$KEY")` leaves a trailing newline and `--release "$TAG"` with an
   * unset TAG leaves an empty string. Both used to be indistinguishable from "not set", so the
   * CLI carried on and uploaded the build under the release named "".
   */
  it('trims, and refuses what is blank after trimming, by name', () => {
    expect(from([], { VINKTAR_CLI_KEY: '  vnk_sk_a\n' }).key).toBe('vnk_sk_a');

    const blank = from(['--release=   ']);
    expect(blank.errors.join('\n')).toContain('--release is empty');
  });

  it('refuses a release the server would silently truncate or reject', () => {
    expect(from(['--release', 'x'.repeat(65)]).errors.join('\n')).toContain('longer than 64 bytes');
    expect(from(['--release', 'v1/2']).errors.join('\n')).toContain('may not contain a slash');
    expect(from(['--release', 'v1 2']).errors.join('\n')).toContain('may not contain whitespace');
    expect(from(['--dist', '..']).errors.join('\n')).toContain('not a usable dist');
  });

  it('refuses a host that is not an http url', () => {
    expect(from(['--host', 'in.vinktar.com']).errors.join('\n')).toContain('is not a URL');
    expect(from(['--host', 'ftp://in.vinktar.com']).errors.join('\n')).toContain('must be http or https');
    expect(from(['--host', 'https://in.example.test/']).host).toBe('https://in.example.test');
  });

  it('refuses a number that is not one', () => {
    expect(from(['--concurrency', '0']).errors.join('\n')).toContain('between 1 and 32');
    expect(from(['--concurrency', 'lots']).errors.join('\n')).toContain('between 1 and 32');
    expect(from(['--concurrency', '8']).concurrency).toBe(8);
    // Seconds in, milliseconds out: nobody types a timeout in milliseconds.
    expect(from(['--timeout', '90']).timeoutMs).toBe(90_000);
  });
});

describe('repeatable flags', () => {
  it('keeps every --ignore, rather than only the last', () => {
    expect(from(['--ignore', 'vendor/**', '--ignore', '*.min.js']).ignore).toEqual(['vendor/**', '*.min.js']);
  });

  it('keeps a pattern containing a space intact', () => {
    expect(from(['--ignore', 'my assets/**']).ignore).toEqual(['my assets/**']);
  });

  it('parses --header into a header, and refuses one that is not a header', () => {
    expect(from(['--header', 'X-A: 1', '--header', 'X-B: 2']).headers).toEqual({ 'X-A': '1', 'X-B': '2' });
    expect(from(['--header', 'nonsense']).errors.join('\n')).toContain('is not "Name: value"');
  });

  it('also reads ignore patterns from the environment, as a comma list', () => {
    expect(from(['--ignore', 'a/**'], { VINKTAR_IGNORE: 'b/**, c/**' }).ignore).toEqual(['a/**', 'b/**', 'c/**']);
  });
});

describe('switches', () => {
  it('reads the ones that change what gets sent', () => {
    expect(from([]).rewriteSources).toBe(true);
    expect(from(['--no-rewrite-sources']).rewriteSources).toBe(false);
    expect(from([]).inject).toBe(true);
    expect(from(['--no-inject']).inject).toBe(false);
    expect(from(['--dry-run']).dryRun).toBe(true);
  });

  it('reads the ones that change how loud it is, from a flag or the environment', () => {
    expect(from(['--debug']).debug).toBe(true);
    expect(from([], { VINKTAR_LOG_LEVEL: 'debug' }).debug).toBe(true);
    expect(from([], { VINKTAR_QUIET: 'yes' }).quiet).toBe(true);
    expect(from([], { VINKTAR_QUIET: 'no' }).quiet).toBe(false);
    expect(from([], { VINKTAR_ALLOW_FAILURE: '1' }).allowFailure).toBe(true);
  });
});

describe('reading a .env file', () => {
  const file = async (body: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'vinktar-env-'));
    const path = join(dir, '.env');
    await writeFile(path, body, 'utf8');

    return path;
  };

  it('reads only VINKTAR_ names, unquoting and dropping a trailing comment', async () => {
    const { values } = await loadDotEnv(
      await file('# a comment\nVINKTAR_KEY="vnk_pk_a"\nexport VINKTAR_HOST=https://x.test # staging\nOTHER=nope\n'),
    );

    expect(values).toEqual({ VINKTAR_KEY: 'vnk_pk_a', VINKTAR_HOST: 'https://x.test' });
  });

  /**
   * A `.env` that can reference the process environment is a `.env` that can exfiltrate it —
   * `VINKTAR_HOST=https://$AWS_SECRET_ACCESS_KEY.example.com` is a one-line leak in a file people
   * paste from a README.
   */
  it('does not interpolate, so a file cannot read the environment it sits in', async () => {
    const { values } = await loadDotEnv(await file('VINKTAR_HOST=https://$SECRET.example\n'));

    expect(values['VINKTAR_HOST']).toBe('https://$SECRET.example');
  });

  it('names the line of anything it could not read', async () => {
    const { warnings } = await loadDotEnv(await file('VINKTAR_KEY=a\nthis is not a setting\n'));

    expect(warnings.join('\n')).toContain(':2 is not NAME=value');
  });

  it('reports a missing file rather than throwing, so a default path is harmless', async () => {
    const missing = await loadDotEnv(join(tmpdir(), 'vinktar-nope', '.env'));

    expect(missing.found).toBe(false);
    expect(missing.values).toEqual({});
  });
});
