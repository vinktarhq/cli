import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { disabled, injectIntoMap, isScript, session, stamp, type BundlerOptions } from './core.js';

export type { BundlerOptions } from './core.js';

/**
 * The esbuild plugin.
 *
 * ```js
 * import { vinktarEsbuild } from '@vinktarhq/cli/esbuild';
 * await esbuild.build({ plugins: [vinktarEsbuild()], metafile: true, sourcemap: true });
 * ```
 *
 * ## One honest caveat
 *
 * esbuild has no hook between generating a chunk and writing it, so unlike the Rollup and webpack
 * plugins this one edits the files afterwards. If the build uses `[hash]` in `entryNames` or
 * `chunkNames`, that hash is computed over the pre-injection bytes and will not match the file on
 * disk — the plugin says so once, rather than leaving it to be discovered by a service worker
 * serving a permanently stale chunk. Nothing in esbuild's API avoids it today; every source-map
 * tool for esbuild has the same limitation. Either leave the hash out, or use the Rollup/Vite
 * plugin where the hook exists.
 *
 * `metafile: true` is required — it is how the plugin learns which files were written.
 */

interface BuildResult {
  metafile?: { outputs: Record<string, unknown> };
  errors?: unknown[];
}

interface Build {
  initialOptions: {
    metafile?: boolean;
    outdir?: string;
    outfile?: string;
    entryNames?: string;
    chunkNames?: string;
    write?: boolean;
  };
  onEnd(callback: (result: BuildResult) => Promise<void> | void): void;
}

export interface EsbuildPlugin {
  name: string;
  setup(build: Build): void;
}

export function vinktarEsbuild(options: BundlerOptions = {}): EsbuildPlugin {
  if (disabled(options)) return { name: 'vinktar', setup: () => {} };

  const stamping = options.injectDebugIds !== false;

  return {
    name: 'vinktar',

    setup(build: Build): void {
      const run = session(options);
      let warnedAboutHash = false;

      build.onEnd(async (result) => {
        // A failed build has nothing worth stamping, and stamping a partial output is worse than
        // leaving it alone.
        if ((result.errors ?? []).length > 0) return;

        if (build.initialOptions.write === false) {
          console.warn('[vinktar] esbuild is configured with `write: false`, so there are no files to stamp; skipping');

          return;
        }

        if (result.metafile === undefined) {
          console.warn('[vinktar] esbuild needs `metafile: true` to find its output; skipping');

          return;
        }

        if (!warnedAboutHash && hashed(build.initialOptions)) {
          warnedAboutHash = true;
          console.warn(
            '[vinktar] esbuild computes [hash] before a plugin can touch the output, so the debug id is not in the hash. ' +
              'The filenames are still stable and the upload is correct; anything that re-hashes the file (SRI, a service-worker precache manifest) will disagree with the name.',
          );
        }

        for (const file of stamping ? Object.keys(result.metafile.outputs) : []) {
          if (!isScript(file)) continue;

          try {
            const code = await readFile(file, 'utf8');
            const stamped = stamp(code);
            if (!stamped.changed) continue;

            await writeFile(file, stamped.code, 'utf8');

            const map = mapOf(file, code);
            if (map === null) continue;

            const raw = await readFile(map, 'utf8').catch(() => null);
            if (raw === null) continue;

            // Same pass, same bytes: the inserted line shifts every mapping below it, and a map
            // left unshifted resolves every frame to the line above the one that threw.
            await writeFile(map, injectIntoMap(raw, stamped.debugId, stamped.line), 'utf8');
          } catch {
            // A file esbuild reported but did not write, or one on a read-only volume. One
            // unstamped chunk matches by release + url; a failed build helps nobody.
          }
        }

        const dir = build.initialOptions.outdir ?? dirOf(build.initialOptions.outfile);
        if (dir === '') return;

        await run.upload(dir);
        await run.cleanup();
      });
    },
  };
}

const SOURCE_MAPPING_COMMENT = /^\/\/[#@] sourceMappingURL=(.*)$/gm;

/** The map beside a chunk: what the chunk says first, then the sibling esbuild writes by default. */
function mapOf(file: string, code: string): string | null {
  let last: RegExpExecArray | null = null;
  for (const match of code.matchAll(SOURCE_MAPPING_COMMENT)) last = match;

  const referenced = last?.[1]?.trim();
  if (referenced !== undefined && referenced !== '' && !referenced.startsWith('data:') && !/^[a-z]+:\/\//i.test(referenced)) {
    return resolve(dirname(file), (referenced.split('?')[0] ?? '').split('#')[0] ?? '');
  }

  return `${file}.map`;
}

function hashed(options: { entryNames?: string; chunkNames?: string }): boolean {
  return (options.entryNames ?? '').includes('[hash]') || (options.chunkNames ?? '').includes('[hash]');
}

function dirOf(outfile: string | undefined): string {
  if (outfile === undefined || outfile === '') return '';
  const slash = outfile.lastIndexOf('/');

  return slash === -1 ? '.' : outfile.slice(0, slash);
}
