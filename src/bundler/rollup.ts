import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { setDebugIdComment, shiftMappings } from '../debug-id.js';
import { discover } from '../discover.js';
import { disabled, session, stamp, type BundlerOptions } from './core.js';

export type { BundlerOptions } from './core.js';

/**
 * The Rollup plugin, which is also the shape Vite takes.
 *
 * ```js
 * import { vinktarRollup } from '@vinktarhq/cli/rollup';
 * export default { plugins: [vinktarRollup({ urlPrefix: '/assets/' })] };
 * ```
 *
 * `renderChunk` with `order: 'post'` is the whole trick: it is the last hook that can change a
 * chunk's bytes, and it runs before Rollup computes the content hash that goes in the filename.
 * Anything later — including writing the files and editing them afterwards, which is what this
 * plugin used to do — leaves every hash in the build describing content that no longer exists.
 */
export interface RollupPlugin {
  name: string;
  buildStart(): void;
  renderChunk: {
    order: 'post';
    handler(this: unknown, code: string, chunk: unknown): { code: string; map: null } | null;
  };
  generateBundle: {
    order: 'pre';
    handler(options: unknown, bundle: Record<string, unknown>): void;
  };
  writeBundle(options: { dir?: string; file?: string }, bundle: Record<string, unknown>): Promise<void>;
  closeBundle(): Promise<void>;
}

/** What a chunk got in `renderChunk`, so the map can be squared up afterwards. */
export interface ChunkStamp {
  readonly debugId: string;
  /** Generated line the snippet occupies, or null when it was appended and nothing moved. */
  readonly line: number | null;
}

interface ChunkShape {
  type?: string;
  fileName?: string;
  preliminaryFileName?: string;
  code?: string;
  map?: { mappings?: unknown } | null;
}

/**
 * Whether the snippet can go at the TOP of this chunk without corrupting its map.
 *
 * Under Rollup it can: nothing re-derives the map after `renderChunk`, so the inserted line is
 * accounted for exactly, in `repairChunks`.
 *
 * Under Rolldown it cannot, and this is the difference between a working map and a meaningless
 * one. Rolldown's Oxc minifier runs AFTER every `renderChunk` hook and rebuilds the chunk's map
 * from the code we hand it, composed against a base that knows nothing about our extra line — so
 * every mapping in the file lands inside the snippet. A build proved it: the first segment of a
 * Vite 8 chunk pointed at generated column 1, which is the middle of the injected IIFE.
 *
 * There is no hook between those two steps, and expressing the insertion as a real transform map
 * would mean emitting a segment per token for every chunk — which is what both incumbents do, and
 * what their magic-string dependency is for. Appending moves nothing, so it needs no map at all;
 * the cost is that a chunk which throws while initialising does not register its id there.
 *
 * `this.meta.rolldownVersion` is Rolldown's own marker, absent under Rollup.
 */
function prependable(context: unknown): boolean {
  return (context as { meta?: { rolldownVersion?: unknown } } | undefined)?.meta?.rolldownVersion === undefined;
}

/**
 * The name a chunk answers to in every hook.
 *
 * `fileName` still holds a hash PLACEHOLDER during `renderChunk` — the whole point of the hook is
 * that the hash has not been computed yet — so keying on it there and looking it up by the final
 * name later matched nothing at all. `preliminaryFileName` is the one that is stable across both.
 */
function keyOf(chunk: ChunkShape): string {
  return chunk.preliminaryFileName ?? chunk.fileName ?? '';
}

/** Stamp one chunk and remember what its map will owe. Shared with the Vite plugin. */
export function stampChunk(
  code: string,
  rawChunk: unknown,
  tracked: Map<string, ChunkStamp>,
  context?: unknown,
): { code: string; map: null } | null {
  const chunk = (rawChunk ?? {}) as ChunkShape;
  const stamped = stamp(code, { prepend: prependable(context) });

  tracked.set(keyOf(chunk), { debugId: stamped.debugId, line: stamped.line });

  /**
   * `map: null`, and it must be exactly that — not an omitted key.
   *
   * Rollup reads it as a strict null check: `null` keeps this transform OUT of the chunk's
   * sourcemap chain and leaves the existing map alone, while `undefined` (an omitted key) enters
   * the chain as a MISSING link, which makes Rollup log `SOURCEMAP_BROKEN` and collapse the whole
   * chain to empty mappings. The line this inserted is accounted for in {@link repairChunks}
   * instead, exactly, rather than through a generated transform map.
   */
  return stamped.changed ? { code: stamped.code, map: null } : null;
}

/**
 * Square the chunk's map up with the snippet, and put back the comment that ran after us.
 *
 * Both halves belong in `generateBundle` with `order: 'pre'`, and both are load-bearing:
 *
 * - **The comment.** Vite 8 is Rolldown, and its Oxc minifier runs after `renderChunk`: it strips
 *   the `//# debugId=` line and leaves the snippet, so the uploader read no id, derived a fresh
 *   one from the minified bytes and filed the map under an id no stack frame reports. The
 *   embedded marker survives minification and is what this package reads back, but the comment is
 *   what every OTHER tool reads.
 * - **The mappings.** Inserting a line above the code shifts every generated line below it by
 *   one, and splicing one empty group into `mappings` is the exact repair. It has to happen HERE,
 *   before any other plugin's `generateBundle`, because Vite's own
 *   `vite:build-import-analysis` rewrites the entry chunk and then does
 *   `combineSourcemaps(fileName, [itsMap, chunk.map])`. Its map is measured against the code
 *   INCLUDING our line; combining it with a `chunk.map` that is one line short does not merely
 *   lose precision, it collapses to empty mappings — the entry chunk of every Vite build with a
 *   dynamic import, silently resolving nothing.
 *
 * `order: 'pre'` is therefore not politeness; it is the difference between a working map and an
 * empty one.
 */
export function repairChunks(bundle: Record<string, unknown>, tracked: Map<string, ChunkStamp>): void {
  for (const asset of Object.values(bundle)) {
    const chunk = asset as ChunkShape;
    if (chunk.type !== 'chunk' || typeof chunk.code !== 'string') continue;

    const found = tracked.get(keyOf(chunk));
    if (found === undefined) continue;

    // Placed the way `inject` places it — before a trailing `sourceMappingURL`, never after.
    // Devtools stop reading at the mapping comment, so a debugId line below it would make the map
    // unreachable, which is a strange way to fix a source-map tool.
    chunk.code = setDebugIdComment(chunk.code, found.debugId);

    const map = chunk.map;
    if (map === null || map === undefined || typeof map.mappings !== 'string') continue;

    if (found.line !== null) {
      map.mappings = String(shiftMappings({ mappings: map.mappings }, found.line)['mappings']);
    }
    // Vite carries `debugId` across its own re-combination by name, and nothing else, so this is
    // the one field worth setting here rather than only on disk.
    (map as Record<string, unknown>)['debugId'] = found.debugId;
  }
}

/**
 * Write each chunk's map to disk, because Rollup will not write ours.
 *
 * Rollup emits a chunk's map from the reference it captured while rendering, so an edit made in
 * `generateBundle` reaches the bundle object every other plugin sees and never reaches the file.
 * It survived for chunks a later Vite plugin happened to rebuild and vanished for the rest, which
 * is the worst shape a bug of this kind can take: half the maps in a build one line out, and no
 * warning from anything.
 *
 * Writing the file afterwards is safe in a way that rewriting a chunk would not be. Nothing hashes
 * a source map: its name comes from the chunk's, no integrity attribute covers it, and no importer
 * reads its contents.
 */
export async function writeMaps(
  dir: string,
  bundle: Record<string, unknown>,
  tracked: Map<string, ChunkStamp>,
  done: Set<string>,
): Promise<void> {
  const chunks = Object.values(bundle).filter((asset): asset is ChunkShape => {
    const chunk = asset as ChunkShape;

    return chunk.type === 'chunk' && tracked.has(keyOf(chunk));
  });

  if (process.env['VINKTAR_DEBUG_TRACK']) console.log('WRITEMAPS', dir, chunks.length, [...tracked.keys()], Object.keys(bundle));
  if (chunks.length === 0) return;

  // One walk of the output, reusing the chunk-to-map resolution the uploader uses — which asks
  // the chunk what its map is called before assuming a `<file>.map` sibling, and so copes with
  // `output.sourcemapFileNames`.
  const { artifacts } = await discover(dir).catch(() => ({ artifacts: [] }));
  const maps = new Map(artifacts.map((artifact) => [artifact.file, artifact.map]));

  for (const chunk of chunks) {
    const found = tracked.get(keyOf(chunk))!;
    const map = chunk.map;
    if (map === null || map === undefined || typeof map.mappings !== 'string') continue;

    const path = maps.get(join(dir, chunk.fileName ?? ''));
    if (process.env['VINKTAR_DEBUG_TRACK']) console.log('WM', chunk.fileName, path, found.line, typeof map.mappings);
    // Idempotent per file per build: `writeBundle` fires once per output, and two outputs writing
    // into one directory must not each rewrite the other's maps.
    if (path === undefined || path === null || done.has(path)) continue;
    done.add(path);

    try {
      await writeFile(
        path,
        JSON.stringify({ ...(map as object), debugId: found.debugId, debug_id: found.debugId }),
        'utf8',
      );
    } catch {
      // A read-only volume, or a map the bundler did not actually write. The chunk still carries
      // its id, and the uploader will stamp whatever map it does find.
    }
  }
}

export function vinktarRollup(options: BundlerOptions = {}): RollupPlugin {
  if (disabled(options)) return inert();

  const tracked = new Map<string, ChunkStamp>();
  const repaired = new Set<string>();
  const stamping = options.injectDebugIds !== false;
  const run = session(options);

  return {
    name: 'vinktar',

    buildStart() {
      // A watch rebuild rewrites every file, so last build's bookkeeping would suppress this
      // build's repairs.
      tracked.clear();
      repaired.clear();
    },

    renderChunk: {
      order: 'post',
      handler(this: unknown, code: string, chunk: unknown) {
        return stamping ? stampChunk(code, chunk, tracked, this) : null;
      },
    },

    generateBundle: {
      order: 'pre',
      handler(_options: unknown, bundle: Record<string, unknown>) {
        repairChunks(bundle, tracked);
      },
    },

    /**
     * Every output, not the first one.
     *
     * The previous version latched on the output directory and returned early for the rest, so a
     * build with a client output and an SSR output — SvelteKit, Nuxt, Remix, or plain
     * `output: [a, b]` — uploaded the first and silently dropped the second. Re-uploading costs
     * nothing: the content hashes are checked against the server before any bytes are sent.
     */
    async writeBundle(output: { dir?: string; file?: string }, bundle: Record<string, unknown>): Promise<void> {
      const dir = outputDir(output);
      if (dir === '') return;

      await writeMaps(dir, bundle, tracked, repaired);
      await run.upload(dir);
      // Deleting here rather than only in `closeBundle`, because `closeBundle` fires only when the
      // caller closes the bundle — Vite and the Rollup CLI do, `rollup.rollup().write()` does not.
      // Leaving the maps in a public directory on that path is the exact leak this deletes.
      await run.cleanup();
    },

    async closeBundle(): Promise<void> {
      await run.cleanup();
    },
  };
}

/**
 * The plugin that does nothing, for `disable: true`.
 *
 * A whole plugin rather than a flag threaded through every hook, so that a config reused by
 * vitest or Storybook costs a function call and not a directory walk.
 */
function inert(): RollupPlugin {
  return {
    name: 'vinktar',
    buildStart() {},
    renderChunk: { order: 'post', handler: () => null },
    generateBundle: { order: 'pre', handler: () => {} },
    writeBundle: async () => {},
    closeBundle: async () => {},
  };
}

function outputDir(output: { dir?: string; file?: string }): string {
  const dir = output.dir ?? (output.file === undefined ? '' : join(output.file, '..'));
  if (dir === '') return '';

  return isAbsolute(dir) ? dir : join(process.cwd(), dir);
}
