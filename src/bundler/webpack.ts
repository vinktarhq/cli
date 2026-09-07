import { disabled, injectIntoMap, isScript, session, stamp, type BundlerOptions } from './core.js';

/**
 * The webpack plugin, which is also the rspack plugin.
 *
 * ```js
 * const { vinktarWebpack } = require('@vinktarhq/cli/webpack');
 * module.exports = { plugins: [new vinktarWebpack({ urlPrefix: '/static/' })] };
 * ```
 *
 * rspack reimplements webpack's plugin API, including `processAssets` and its stage constants, so
 * one class serves both. `@vinktarhq/cli/rspack` re-exports this under its own name because that is
 * what a reader of an rspack config expects to see.
 *
 * ## The stage matters
 *
 * `PROCESS_ASSETS_STAGE_OPTIMIZE_HASH` is the documented point for "changing the asset in a way
 * that affects its hash", and it is where the real content hashes are computed. Doing this any
 * later — in `afterEmit`, say — means the file on disk no longer matches the hash in its own name,
 * and everything downstream that recorded that hash (a PWA precache manifest, an integrity
 * attribute, a precompressed copy) is pointing at bytes that are gone.
 *
 * One BEFORE it, though, not at it. Taps sharing a stage run in registration order, and rspack's
 * real-content-hash pass is native and registered before any user plugin — so at the stage itself
 * the hash was computed from the pre-injection bytes and the filename described a file that never
 * existed. A build proved it: with the plugin and without it, rspack emitted the same
 * `main.<hash>.js` for different content. webpack is unaffected either way, so both take the
 * earlier slot.
 *
 * It is also after `PROCESS_ASSETS_STAGE_DEV_TOOLING`, which is where `SourceMapDevToolPlugin`
 * emits the `.map` assets and appends the `sourceMappingURL` comment. That ordering is what lets
 * the map be corrected in the same pass as the chunk: the injected line shifts every mapping
 * below it, and a map fixed in a later hook would already have been hashed and written.
 */

/** Just enough of webpack's shape to compile without depending on it. */
interface Compiler {
  hooks: {
    thisCompilation: { tap(name: string, fn: (compilation: Compilation) => void): void };
    afterEmit: { tapPromise(name: string, fn: (compilation: Compilation) => Promise<void>): void };
  };
  options: { output?: { path?: string } };
  webpack?: { Compilation?: { PROCESS_ASSETS_STAGE_OPTIMIZE_HASH?: number }; sources?: SourceLibrary };
}

interface SourceLibrary {
  RawSource: new (value: string) => unknown;
}

interface Compilation {
  hooks: {
    processAssets: {
      tap(options: { name: string; stage: number }, fn: (assets: Record<string, Asset>) => void): void;
    };
  };
  updateAsset(name: string, source: unknown): void;
  getAsset(name: string): { source: Asset } | undefined;
}

interface Asset {
  source(): string | Buffer;
}

const NAME = 'vinktar';

/** webpack's own value for this stage, when the compiler does not expose the constant. */
const STAGE_OPTIMIZE_HASH = 2500;

export class VinktarWebpackPlugin {
  constructor(private readonly options: BundlerOptions = {}) {}

  apply(compiler: Compiler): void {
    if (disabled(this.options)) return;

    const stamping = this.options.injectDebugIds !== false;
    const RawSource = compiler.webpack?.sources?.RawSource;
    const stage =
      (compiler.webpack?.Compilation?.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH ?? STAGE_OPTIMIZE_HASH) - 1;
    const run = session(this.options);

    compiler.hooks.thisCompilation.tap(NAME, (compilation) => {
      compilation.hooks.processAssets.tap({ name: NAME, stage }, (assets) => {
        if (!stamping) return;

        const write = (name: string, value: string): void => {
          // `RawSource` is reached through the compiler rather than imported, so this file has no
          // build-time dependency on webpack at all — and so rspack's own sources are used under
          // rspack rather than webpack's.
          compilation.updateAsset(name, RawSource === undefined ? value : new RawSource(value));
        };

        for (const name of Object.keys(assets)) {
          if (!isScript(name)) continue;

          const asset = compilation.getAsset(name);
          if (asset === undefined) continue;

          const code = String(asset.source.source());
          const stamped = stamp(code);
          if (!stamped.changed) continue;

          write(name, stamped.code);

          // The map is corrected in the same stage, from the same bytes. Skipping it leaves every
          // line one out of step, which is worse than no map: the frame resolves, to the wrong
          // line, and nobody doubts a source map that answered.
          const mapName = mapAssetOf(name, code, assets);
          if (mapName === null) continue;

          const map = compilation.getAsset(mapName);
          if (map === undefined) continue;

          try {
            write(mapName, injectIntoMap(String(map.source.source()), stamped.debugId, stamped.line));
          } catch {
            // A map asset that is not JSON is not ours to rewrite.
          }
        }
      });
    });

    compiler.hooks.afterEmit.tapPromise(NAME, async () => {
      const dir = compiler.options.output?.path ?? '';
      if (dir === '') return;

      await run.upload(dir);
      await run.cleanup();
    });
  }
}

const SOURCE_MAPPING_COMMENT = /^\/\/[#@] sourceMappingURL=(.*)$/gm;

/**
 * The map asset belonging to a chunk asset.
 *
 * `output.sourceMapFilename` is configurable — `[file].map` is only the default, and a build that
 * puts maps under `sourcemaps/[name].map` has no `<file>.map` asset at all. The chunk names its
 * own map in the comment `SourceMapDevToolPlugin` just appended, so that is asked first and the
 * sibling is the fallback.
 */
function mapAssetOf(name: string, code: string, assets: Record<string, unknown>): string | null {
  let last: RegExpExecArray | null = null;
  for (const match of code.matchAll(SOURCE_MAPPING_COMMENT)) last = match;

  const referenced = last?.[1]?.trim();
  if (referenced !== undefined && referenced !== '' && !referenced.startsWith('data:')) {
    const slash = name.lastIndexOf('/');
    const directory = slash === -1 ? '' : name.slice(0, slash + 1);
    const target = normalise(`${directory}${(referenced.split('?')[0] ?? '').split('#')[0] ?? ''}`);

    if (target in assets) return target;
  }

  return `${name}.map` in assets ? `${name}.map` : null;
}

/** Collapse `a/../b` and `./b`, which a relative sourceMappingURL legitimately contains. */
function normalise(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }

  return parts.join('/');
}

/** Named for how a config reads: `new vinktarWebpack({ … })`. */
export const vinktarWebpack = VinktarWebpackPlugin;

// Re-exported so a config can type its own options without reaching into the package root, which
// is the ESM-only entry point — a CommonJS `webpack.config.js` cannot import from there at all.
export type { BundlerOptions } from './core.js';
