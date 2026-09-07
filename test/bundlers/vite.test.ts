import { afterEach, describe, expect, it, vi } from 'vitest';

import { vinktar } from '../../src/vite.js';

type ConfigHook = (
  config: Record<string, unknown>,
  env: { command: 'build' | 'serve'; mode: string },
) => Promise<Record<string, unknown>>;

function configHook(plugin: ReturnType<typeof vinktar>): ConfigHook {
  const hook = plugin.config;

  return (typeof hook === 'function' ? hook : hook?.handler) as unknown as ConfigHook;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the vite plugin', () => {
  it('exposes the VINKTAR_* variables to the bundle, never the CLI key', async () => {
    vi.stubEnv('VINKTAR_KEY', 'vnk_pk_test');
    vi.stubEnv('VINKTAR_HOST', 'https://in.example.test');
    vi.stubEnv('VINKTAR_ENVIRONMENT', 'staging');
    vi.stubEnv('VINKTAR_RELEASE', 'r1');
    vi.stubEnv('VINKTAR_CLI_KEY', 'vnk_pk_secret_ci');

    const result = await configHook(vinktar())({}, { command: 'build', mode: 'production' });
    const define = result['define'] as Record<string, string>;

    expect(define['import.meta.env.VINKTAR_KEY']).toBe('"vnk_pk_test"');
    expect(define['import.meta.env.VINKTAR_HOST']).toBe('"https://in.example.test"');
    expect(define['import.meta.env.VINKTAR_ENVIRONMENT']).toBe('"staging"');
    expect(define['import.meta.env.VINKTAR_RELEASE']).toBe('"r1"');
    expect(JSON.stringify(define)).not.toContain('vnk_pk_secret_ci');
    expect(Object.keys(define).join()).not.toContain('CLI');
  });

  it('defaults the release to the full commit sha when VINKTAR_RELEASE is unset', async () => {
    vi.stubEnv('VINKTAR_RELEASE', '');
    // A CI variable would win over git, and every one of these is set inside a GitHub Action.
    for (const name of ['GITHUB_SHA', 'GITHUB_EVENT_NAME', 'CI_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA']) {
      vi.stubEnv(name, '');
    }

    const result = await configHook(vinktar())({}, { command: 'build', mode: 'production' });
    const define = result['define'] as Record<string, string>;

    // The FULL sha, not a short one: the SDK and the CLI read the same variables, and a 7-char
    // prefix on one side against 40 characters on the other is a release mismatch that looks
    // exactly like having set no release at all.
    expect(define['import.meta.env.VINKTAR_RELEASE']).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('turns on hidden sourcemaps for builds', async () => {
    const build = await configHook(vinktar())({}, { command: 'build', mode: 'production' });
    expect((build['build'] as Record<string, unknown>)['sourcemap']).toBe('hidden');

    const serve = await configHook(vinktar())({}, { command: 'serve', mode: 'development' });
    expect(serve['build']).toBeUndefined();
  });

  it('forces `true` to `hidden` while the maps are being deleted, and leaves it alone otherwise', async () => {
    // A `sourceMappingURL` comment pointing at a file this plugin is about to delete is a 404 in
    // every devtools session, so with deletion on the two settings are the same request.
    const deleting = await configHook(vinktar())(
      { build: { sourcemap: true } },
      { command: 'build', mode: 'production' },
    );
    expect((deleting['build'] as Record<string, unknown>)['sourcemap']).toBe('hidden');

    const keeping = await configHook(vinktar({ deleteSourcemapsAfterUpload: false }))(
      { build: { sourcemap: true } },
      { command: 'build', mode: 'production' },
    );
    expect(keeping['build']).toBeUndefined();
  });

  it('says so when the config leaves it nothing to upload', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: string) => void warnings.push(line));

    try {
      await configHook(vinktar())({ build: { sourcemap: false } }, { command: 'build', mode: 'production' });
      await configHook(vinktar())({ build: { sourcemap: 'inline' } }, { command: 'build', mode: 'production' });
    } finally {
      spy.mockRestore();
    }

    expect(warnings.join('\n')).toContain('build.sourcemap is false');
    expect(warnings.join('\n')).toContain('build.sourcemap is "inline"');
  });
});
