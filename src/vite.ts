import { isAbsolute, join } from 'node:path';

import { detectRelease, disabled, session, type BundlerOptions, type Session } from './bundler/core.js';
import { repairChunks, stampChunk, writeMaps, type ChunkStamp } from './bundler/rollup.js';

/**
 * The plugin's shape, declared here rather than imported as Vite's `Plugin`.
 *
 * Two copies of Vite's types at different patch versions — the consumer's and this package's —
 * are structurally identical and nominally incompatible, so importing `Plugin` makes
 * `plugins: [vinktar()]` fail to typecheck for anyone whose lockfile resolves a different patch
 * than ours. Structural typing has no such problem, and it also means this package's public types
 * do not depend on `vite` at all.
 */
export interface VitePlugin {
  name: string;
  /**
   * `unknown` parameters, deliberately, and it is the direction that matters: a hook which accepts
   * ANYTHING can stand in for one Vite will call with its own config types, whatever version those
   * come from. A hook typed against a narrower shape cannot — which is the whole failure this
   * exists to avoid, and `never` (the first thing that looks right) has exactly the wrong variance.
   */
  config(userConfig: unknown, env: unknown): Promise<{
    define: Record<string, string>;
    build?: { sourcemap: 'hidden' };
  }>;
  configResolved(resolved: unknown): void;
  buildStart(): void;
  renderChunk: {
    order: 'post';
    handler(this: unknown, code: string, chunk: unknown): { code: string; map: null } | null;
  };
  generateBundle: { order: 'pre'; handler(options: unknown, bundle: Record<string, unknown>): void };
  writeBundle(options: unknown, bundle: Record<string, unknown>): Promise<void>;
  closeBundle(): Promise<void>;
}

/** What the plugin actually reads out of Vite's config, and nothing more. */
interface UserConfigShape {
  root?: string | undefined;
  build?: { sourcemap?: unknown } | undefined;
}

interface ResolvedConfigShape {
  command: string;
  base: string;
  root: string;
  build: { outDir: string };
}

/**
 * The Vite side of Vinktar, as one plugin.
 *
 * ```ts
 * // vite.config.ts
 * import { vinktar } from '@vinktarhq/cli/vite';
 *
 * export default defineConfig({ plugins: [vinktar()] });
 * ```
 *
 * What it does, all driven by the same VINKTAR_* variables every other Vinktar SDK reads
 * (from the process env and Vite's .env files):
 *
 * - Exposes `import.meta.env.VINKTAR_KEY`, `VINKTAR_HOST`, `VINKTAR_ENVIRONMENT` and
 *   `VINKTAR_RELEASE` to the bundle, so `init({ key: import.meta.env.VINKTAR_KEY, … })` is the
 *   whole application-side setup. `VINKTAR_CLI_KEY` is NEVER exposed — a bundle is public.
 * - `VINKTAR_RELEASE` falls back to the CI commit, then the git SHA, so errors correlate to a
 *   deploy without anyone wiring a release string.
 * - Turns on `build.sourcemap: 'hidden'`.
 * - Stamps a debug id into each chunk **as it is rendered**, then after the build uploads the maps
 *   under the same release the bundle reports, and removes them from the output directory.
 *
 * ## Why injection is a `renderChunk` hook
 *
 * The previous version rewrote the files in `closeBundle`, after Vite had already written them.
 * That is after Rollup computed the content hash in each filename, after `vite-plugin-pwa` wrote
 * its precache revisions, and after any integrity or precompression plugin had run — so every one
 * of those recorded a hash of bytes that no longer existed on disk. A service worker built that
 * way serves a permanently stale chunk. Injecting during `renderChunk` makes the snippet part of
 * the artifact everything downstream measures.
 */
export interface VinktarPluginOptions extends BundlerOptions {}

export function vinktar(options: VinktarPluginOptions = {}): VitePlugin {
  if (disabled(options)) return inert();

  let env: Record<string, string> = {};
  let release = '';
  let outDir = '';
  let base = '/';
  let building = false;
  const tracked = new Map<string, ChunkStamp>();
  const repaired = new Set<string>();
  let run: Session | null = null;

  const deleting = options.deleteSourcemapsAfterUpload ?? options.uploadSourcemaps !== false;
  const stamping = options.injectDebugIds !== false;

  return {
    name: 'vinktar',

    async config(rawConfig: unknown, rawEnv: unknown) {
      const userConfig = rawConfig as UserConfigShape;
      const { command, mode } = rawEnv as { command: string; mode: string };

      // loadEnv is imported lazily so this module stays importable outside a Vite process.
      const { loadEnv } = await import('vite');
      env = loadEnv(mode, userConfig.root ?? process.cwd(), 'VINKTAR_');
      // Only a build needs a release, and resolving one can shell out to git — not something to do
      // on every dev-server start.
      release = options.release ?? (command === 'build' ? detectRelease({ ...process.env, ...env }) : '');

      const define = {
        'import.meta.env.VINKTAR_KEY': JSON.stringify(env['VINKTAR_KEY'] ?? ''),
        'import.meta.env.VINKTAR_HOST': JSON.stringify(env['VINKTAR_HOST'] ?? ''),
        'import.meta.env.VINKTAR_ENVIRONMENT': JSON.stringify(env['VINKTAR_ENVIRONMENT'] ?? ''),
        'import.meta.env.VINKTAR_RELEASE': JSON.stringify(release),
      };

      if (command !== 'build') return { define };

      const chosen = userConfig.build?.sourcemap;

      if (chosen === 'inline') {
        console.warn(
          '[vinktar] build.sourcemap is "inline", so the maps are inside the chunks and cannot be uploaded. Use true or "hidden".',
        );

        return { define };
      }

      if (chosen === false) {
        console.warn('[vinktar] build.sourcemap is false, so there is nothing to upload and no frame will resolve.');

        return { define };
      }

      // 'hidden': maps exist for the upload, chunks carry no sourceMappingURL comment. Forced over
      // an explicit `true` only while the maps are being deleted afterwards — a comment pointing at
      // a file that is about to be removed is a 404 in every devtools session. Keep the maps
      // (`deleteSourcemapsAfterUpload: false`) and `true` is left exactly as configured.
      if (chosen === undefined || (chosen === true && deleting)) {
        return { define, build: { sourcemap: 'hidden' as const } };
      }

      return { define };
    },

    configResolved(raw: unknown) {
      const resolved = raw as ResolvedConfigShape;

      building = resolved.command === 'build';
      base = resolved.base;
      outDir = isAbsolute(resolved.build.outDir) ? resolved.build.outDir : join(resolved.root, resolved.build.outDir);
    },

    /**
     * A watch rebuild can land on a different commit than the one the process started on, and a
     * stale release is worse than none: the maps go up under a name the running application does
     * not report. Cheap enough to redo — one `git rev-parse`, and only when nothing pinned it.
     */
    buildStart() {
      if (!building) return;

      tracked.clear();
      repaired.clear();
      if (options.release === undefined && (env['VINKTAR_RELEASE'] ?? '') === '') {
        release = detectRelease({ ...process.env, ...env });
      }
      run = session({ urlPrefix: base, ...options, release }, { ...process.env, ...env });
    },

    /**
     * `order: 'post'` is load-bearing, not tidiness.
     *
     * Minification is itself a `renderChunk` hook, and esbuild strips any comment that is not
     * `sourceMappingURL`. Running before it meant the `//# debugId=` line was deleted on every
     * minified build, so the uploader could not read the id back — it re-derived one from the
     * minified bytes instead and filed the map under an id no stack frame would ever report.
     * Running last means the id is stamped into the final bytes, and still before Rollup computes
     * the content hash in the filename.
     */
    renderChunk: {
      order: 'post',
      handler(this: unknown, code: string, chunk: unknown) {
        if (!building || !stamping) return null;

        return stampChunk(code, chunk, tracked, this);
      },
    },

    /**
     * Shift each map by the line the snippet took, and restore the comment the minifier stripped.
     *
     * `order: 'pre'` because Vite's own `vite:build-import-analysis` runs here too, and it
     * re-combines the entry chunk's map with one measured against the code INCLUDING our line.
     * Handing it a map that is a line short collapses that chunk's mappings to nothing.
     */
    generateBundle: {
      order: 'pre',
      handler(_options: unknown, bundle: Record<string, unknown>) {
        if (!building) return;

        repairChunks(bundle, tracked);
      },
    },

    /**
     * `writeBundle`, not `closeBundle`, because it is handed the output options — and the output
     * directory is not always Vite's `build.outDir`. A config that sets
     * `rollupOptions.output.dir` (a theme extension writing straight into `assets/`, say) leaves
     * `build.outDir` at its default, so scanning that found an empty or missing directory and
     * uploaded nothing, silently, on every build.
     *
     * Called once per output, and every one of them is uploaded. The previous version latched on
     * the directory and returned early for the rest, so `@vitejs/plugin-legacy`'s second output —
     * the chunks actually served to the browsers most likely to produce an unreadable stack — was
     * never sent.
     */
    async writeBundle(rawOptions: unknown, bundle: Record<string, unknown>) {
      if (!building) return;

      const dir = directoryOf(rawOptions) || outDir;
      if (dir === '') return;

      // The maps are written again from the bundle, because Rollup emits a chunk's map from the
      // reference it captured while rendering — an edit made in `generateBundle` reaches every
      // other plugin and never reaches the file.
      await writeMaps(dir, bundle, tracked, repaired);

      // `buildStart` normally creates it; a plugin added to an already-running build might not
      // have seen that hook, and an upload that silently does not happen is the whole problem.
      run ??= session({ urlPrefix: base, ...options, release }, { ...process.env, ...env });

      await run.upload(dir);
      await run.cleanup();
    },

    async closeBundle() {
      await run?.cleanup();
    },
  };
}

/**
 * The plugin that does nothing, for `disable: true`.
 *
 * Vite configs are reused by vitest and Storybook, and both would otherwise pay for `loadEnv`, a
 * `git rev-parse` and a walk of a directory they never built.
 */
function inert(): VitePlugin {
  return {
    name: 'vinktar',
    config: async () => ({ define: {} }),
    configResolved: () => {},
    buildStart: () => {},
    renderChunk: { order: 'post', handler: () => null },
    generateBundle: { order: 'pre', handler: () => {} },
    writeBundle: async () => {},
    closeBundle: async () => {},
  };
}

/** Rollup's own output directory, which is the one the files were actually written to. */
function directoryOf(rawOptions: unknown): string {
  const dir = (rawOptions as { dir?: unknown } | null)?.dir;
  if (typeof dir !== 'string' || dir === '') return '';

  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}
