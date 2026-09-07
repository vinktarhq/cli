import { open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { matches } from './glob.js';

/**
 * Finds built JavaScript and the map that belongs to it.
 *
 * Hand-rolled rather than a glob dependency: the package ships with zero runtime dependencies, and
 * "walk a directory" is not worth one.
 */

export interface Artifact {
  /** Absolute path to the .js file. */
  readonly file: string;
  /** Absolute path to its .map, when one could be resolved. */
  readonly map: string | null;
  /** Path relative to the upload root, which is what the URL is derived from. */
  readonly relative: string;
}

export interface Discovery {
  readonly artifacts: Artifact[];
  /** Everything that was skipped and why. Never silent: a missing map is a minified release. */
  readonly warnings: string[];
}

// Entry names, matched against a single directory name. `.next/cache` used to be in here and
// could never match anything, because a directory entry is never a path.
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'coverage', 'cache']);

/** What counts as a chunk, absent `--ext`. */
export const DEFAULT_EXTENSIONS = ['js', 'cjs', 'mjs'];

export interface DiscoverOptions {
  /**
   * Globs, matched against the path relative to the root. An ignored chunk is skipped whole — it
   * is neither stamped nor uploaded, so an ignore rule can never orphan an id by removing a map
   * whose chunk still names it.
   */
  readonly ignore?: readonly string[];
  /** Extensions to treat as chunks, without the dot. Defaults to {@link DEFAULT_EXTENSIONS}. */
  readonly extensions?: readonly string[];
}

/**
 * `//# sourceMappingURL=`, and the legacy `//@` spelling some older toolchains still emit.
 *
 * Matched line-anchored so the string appearing inside a bundled literal — a tool that writes these
 * comments, bundled into an application — cannot be mistaken for a real reference.
 */
const SOURCE_MAPPING_COMMENT = /^\/\/[#@] sourceMappingURL=(.*)$/gm;

/** How much of a chunk's tail is searched for the reference. It is emitted as the final line. */
const TAIL_BYTES = 65_536;

export async function discover(root: string, options: DiscoverOptions = {}): Promise<Discovery> {
  const warnings: string[] = [];
  const files = await walk(root, new Set());
  const script = extensionMatcher(options.extensions);
  const ignore = options.ignore ?? [];

  const scripts = files
    .filter((file) => script.test(file))
    .filter((file) => !matches(relative(root, file).split(sep).join('/'), ignore))
    .sort((a, b) => a.localeCompare(b));
  const present = new Set(files);

  const resolved: Array<{ file: string; map: string | null; explicit: boolean }> = [];
  for (const file of scripts) {
    resolved.push(await locate(file, present, warnings));
  }

  return { artifacts: assign(resolved, root, warnings), warnings };
}

/**
 * The map for one chunk: what it says, then what sits beside it.
 *
 * Asking the chunk first is not a refinement, it is the difference between working and not. A
 * build configured with `sourcemapFileNames`, webpack's `sourceMapFilename`, or any output that
 * puts maps in their own directory has no `<file>.map` sibling at all, so guessing alone found
 * nothing and uploaded nothing, without a word.
 */
async function locate(
  file: string,
  present: ReadonlySet<string>,
  warnings: string[],
): Promise<{ file: string; map: string | null; explicit: boolean }> {
  const referenced = await reference(file);

  if (referenced !== null) {
    if (referenced.startsWith('data:')) {
      // Decoding it would mean rewriting the chunk to carry a map we then upload separately, for a
      // configuration that has already chosen to ship its map to users.
      warnings.push(`${file} has an inline source map; inline maps are not uploaded.`);

      return { file, map: null, explicit: false };
    }

    // A remote or protocol-relative URL names something on a CDN, not on this disk. Joining it to
    // the chunk's directory produced paths like `dist/https:/cdn.example.com/app.js.map`.
    if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(referenced)) {
      const target = clean(referenced);
      const candidate = isAbsolute(target) ? target : resolve(dirname(file), target);

      if (present.has(candidate)) return { file, map: candidate, explicit: true };
    }
  }

  const sibling = `${file}.map`;

  return { file, map: present.has(sibling) ? sibling : null, explicit: false };
}

/** Strip the query and fragment a cache-busting build appends, then percent-decode. */
function clean(url: string): string {
  const bare = (url.split('#')[0] ?? '').split('?')[0] ?? '';

  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** The last `sourceMappingURL` in a chunk, read from its tail rather than its whole body. */
async function reference(file: string): Promise<string | null> {
  let tail: string;
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, size - length));
      tail = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  let last: RegExpExecArray | null = null;
  for (const match of tail.matchAll(SOURCE_MAPPING_COMMENT)) last = match;

  const url = last?.[1]?.trim();

  return url === undefined || url === '' ? null : url;
}

/**
 * Turn resolved pairs into artifacts, refusing any map that more than one chunk claims.
 *
 * Two chunks pointing at one map is not a map serving two chunks: it is a stale reference, a copied
 * file, or a guess that happened to land on someone else's map. Writing a debug id into it would
 * make the last writer win, so the id in the map would disagree with the id in every chunk but one
 * and none of them would resolve. An explicit reference beats a guess, because the chunk that named
 * the map is the one that meant it.
 */
function assign(
  resolved: ReadonlyArray<{ file: string; map: string | null; explicit: boolean }>,
  root: string,
  warnings: string[],
): Artifact[] {
  const claimants = new Map<string, Array<{ file: string; explicit: boolean }>>();
  for (const entry of resolved) {
    if (entry.map === null) continue;
    const list = claimants.get(entry.map) ?? [];
    list.push({ file: entry.file, explicit: entry.explicit });
    claimants.set(entry.map, list);
  }

  const owner = new Map<string, string | null>();
  for (const [map, list] of claimants) {
    if (list.length === 1) {
      owner.set(map, list[0]!.file);
      continue;
    }

    const explicit = list.filter((entry) => entry.explicit);
    if (explicit.length === 1) {
      owner.set(map, explicit[0]!.file);
      warnings.push(
        `${map} is claimed by ${list.length} chunks; using the one that references it (${explicit[0]!.file}).`,
      );
      continue;
    }

    owner.set(map, null);
    warnings.push(
      `${map} is claimed by ${list.length} chunks and none of them names it; leaving all of them without a map.`,
    );
  }

  return resolved.map((entry) => ({
    file: entry.file,
    map: entry.map !== null && owner.get(entry.map) === entry.file ? entry.map : null,
    // Always forward slashes: a URL is not a Windows path.
    relative: relative(root, entry.file).split(sep).join('/'),
  }));
}

/**
 * Every file under a directory, each one exactly once.
 *
 * Symlinks are followed, and the real path of each directory is remembered, because a build output
 * that links to a shared asset directory is ordinary and a link that points back up the tree is a
 * loop. Visiting a file twice would stamp it twice and upload a stale copy of it.
 */
async function walk(directory: string, seen: Set<string>): Promise<string[]> {
  const real = await realpath(directory).catch(() => directory);
  if (seen.has(real)) return [];
  seen.add(real);

  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      // `readdir` reports the link, never its target, so a symlinked chunk is neither a file nor a
      // directory here and was silently dropped from every build that used one.
      const target = await stat(path).catch(() => null);
      if (target === null) continue;
      isDirectory = target.isDirectory();
      isFile = target.isFile();
    }

    if (isDirectory) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await walk(path, seen)));
      continue;
    }

    if (isFile) found.push(path);
  }

  return found;
}

/**
 * Every file under a directory, absolute, each one once.
 *
 * Exported for the plugins' cleanup pass, which has to find files `discover` deliberately ignores
 * — a `.css.map` is not a chunk, but it is still the stylesheet's sources sitting in a public
 * directory.
 */
export async function allFiles(root: string): Promise<string[]> {
  return walk(root, new Set());
}

/**
 * `--ext ts,mts` and friends, escaped.
 *
 * Escaped because the value comes from a command line, and an extension containing a regex
 * metacharacter would otherwise quietly widen the match rather than fail — which is the kind of
 * bug that shows up as "why did it upload that".
 */
function extensionMatcher(extensions: readonly string[] = DEFAULT_EXTENSIONS): RegExp {
  const cleaned = extensions
    .map((extension) => extension.trim().replace(/^\./, ''))
    .filter((extension) => extension !== '')
    .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (cleaned.length === 0) return new RegExp(`\\.(?:${DEFAULT_EXTENSIONS.join('|')})$`);

  return new RegExp(`\\.(?:${cleaned.join('|')})$`);
}

export async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

/**
 * A map that cannot resolve anything: no mappings and no sources.
 *
 * Vite emits one per HTML entry in a multi-page build, for a facade chunk that is nothing but
 * imports. Stamping those produces ids no frame will ever report and uploads bytes that answer no
 * question. "Empty" deliberately means the MAP is empty and never that the code is short: a small
 * single-page entry chunk is real code whose frames matter.
 */
export function isEmptyMap(mapJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(mapJson);
    if (typeof parsed !== 'object' || parsed === null) return false;

    const map = parsed as Record<string, unknown>;
    if (Array.isArray(map['sections'])) return map['sections'].length === 0;

    const mappings = map['mappings'];
    const sources = map['sources'];

    return (
      (typeof mappings !== 'string' || mappings === '') && (!Array.isArray(sources) || sources.length === 0)
    );
  } catch {
    return false;
  }
}
