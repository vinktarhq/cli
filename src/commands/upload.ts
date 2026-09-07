import { discover, type Artifact, type DiscoverOptions } from '../discover.js';
import { MAX_FILE_BYTES } from '../limits.js';
import {
  batch,
  DEFAULT_CONCURRENCY,
  index,
  materialise,
  mb,
  pooled,
  preflight,
  send,
  type Limits,
  type UploadEntry,
  type UploadOptions,
} from '../upload.js';
import { normalise } from '../url.js';
import { audit, inject } from './inject.js';

/** One map the server is known to hold after this run, and the bytes it was holding it for. */
export interface StoredMap {
  /** Absolute path to the .map file. */
  readonly map: string;
  /** Absolute path to the chunk it belongs to. */
  readonly chunk: string;
  /** sha256 of the map file as it was read. A plugin re-checks this before deleting it. */
  readonly sha256: string;
}

export interface UploadSummary {
  /** Newly stored server-side. Zero on a re-run of the same build, which is not a failure. */
  readonly stored: number;
  /** Maps actually sent in this run. */
  readonly uploaded: number;
  /** Files with no `.map` beside them. */
  readonly skipped: number;
  /** Maps the server already held, so they were not sent again. */
  readonly alreadyStored: number;
  /** Maps over the per-file ceiling. Skipped, never fatal. */
  readonly oversized: number;
  /** Chunks whose map resolves nothing at all, so there was no point sending it. */
  readonly empty: number;
  /** Chunks dropped because another chunk in the same build carries the same debug id. */
  readonly duplicates: number;
  /** Bytes actually sent. */
  readonly bytes: number;
  /** Chunks stamped by this run (zero on a re-run, or with `inject: false`). */
  readonly injected: number;
  /** Chunks sent without a debug id in them. Only ever non-zero with `inject: false`. */
  readonly uninjected: number;
  /**
   * The maps that are on the server after this run — the ones just sent plus the ones it already
   * held. What a caller may safely delete from the build output; deleting by a fresh directory
   * sweep instead is how the Vite plugin used to throw away maps it never touched.
   */
  readonly storedMaps: StoredMap[];
  /** Everything discovery skipped, and why. */
  readonly warnings: string[];
  /** What the server said it accepts, when it said anything. */
  readonly limits?: Limits | null;
}

export interface UploadCommandOptions extends UploadOptions, DiscoverOptions {
  readonly dryRun: boolean;
  /**
   * Stamp the chunks and maps before uploading. Default true: a map uploaded from an un-injected
   * chunk can only ever match by release + url, and the server cannot link the two after the fact.
   */
  readonly inject?: boolean;
}

/**
 * Upload every map under `root`, injecting debug ids first unless told not to.
 *
 * Three passes, in this order for a reason:
 *
 * 1. **Index.** Every map is built, measured and hashed, then thrown away. A build of two hundred
 *    chunks is hundreds of megabytes; keeping all of it resident until the first request went out
 *    was the previous shape.
 * 2. **Ask.** One request tells us which bodies the server already has. A redeploy of an unchanged
 *    build then sends nothing at all, which is the difference between a source-map quota that
 *    lasts and one that fills up in a week.
 * 3. **Send.** Batches, bounded by bytes, several in flight, each map read back from disk as its
 *    batch goes.
 *
 * Prints the NORMALISED url alongside each file, because that is the string the server will
 * actually compare a runtime frame against. A mismatch between what you expect to be serving and
 * what will be stored is otherwise invisible until stack traces silently stay minified, and by
 * then the deploy is done and nobody connects the two.
 *
 * A summary line is printed on every exit path, including a thrown one. A build step whose last
 * output is a stack trace tells you it failed and not what it had managed to do first.
 */
export async function upload(
  root: string,
  options: UploadCommandOptions,
  log: (line: string) => void,
  warn: (line: string) => void = log,
): Promise<UploadSummary> {
  let injected = 0;

  if (options.inject !== false) {
    if (options.dryRun) {
      // A dry run touches nothing, but the id it prints is the one injection would derive, so
      // the output is still what the real run will send.
      const found = await audit(root, options);
      if (found.notInjected > 0) log(`Would inject debug ids into ${found.notInjected} chunk(s).`);
    } else {
      const result = await inject(root, () => {}, options);
      injected = result.injected;
      if (result.injected > 0 || result.repaired > 0) {
        log(
          `Injected debug ids into ${result.injected} chunk(s)` +
            `${result.adopted > 0 ? `, ${result.adopted} adopted from the bundler` : ''}` +
            `${result.repaired > 0 ? `, ${result.repaired} map(s) repaired` : ''}` +
            `${result.skipped > 0 ? `, ${result.skipped} already stamped` : ''}.`,
        );
      }
      for (const line of result.warnings) warn(`WARNING: ${line}`);
    }
  }

  const { artifacts, warnings } = await discover(root, options);
  if (options.inject === false) {
    for (const line of warnings) warn(`WARNING: ${line}`);
  }

  const indexed: Array<{ artifact: Artifact; entry: UploadEntry }> = [];
  const oversized: UploadEntry[] = [];
  const seenIds = new Map<string, string>();
  const seenMaps = new Set<string>();
  let skipped = 0;
  let blank = 0;
  let duplicates = 0;

  for (const artifact of artifacts) {
    // A map two chunks both point at belongs to neither of them, and `discover` has already
    // refused it for both. This only catches the same map reached twice.
    if (artifact.map !== null && seenMaps.has(artifact.map)) continue;

    const found = await index(artifact, options.urlPrefix, options);
    if (found === null) {
      skipped += 1;
      continue;
    }
    if (found.oversized) {
      oversized.push(found.entry);
      continue;
    }
    if (found.empty) {
      blank += 1;
      continue;
    }

    // Byte-identical chunks emitted under two names derive the same id, and the server keeps one
    // artifact per debug id: sending both means the second silently replaces the first, so the
    // url stored for that id is whichever request happened to land last.
    const already = seenIds.get(found.entry.debugId);
    if (already !== undefined) {
      duplicates += 1;
      warn(
        `WARNING: ${found.entry.name} has the same debug id as ${already}; only the first is uploaded. ` +
          'The two chunks are byte-identical, so frames from either resolve through the same map.',
      );
      continue;
    }

    seenIds.set(found.entry.debugId, found.entry.name);
    if (artifact.map !== null) seenMaps.add(artifact.map);
    indexed.push({ artifact, entry: found.entry });
  }

  // Loud, but not fatal. Losing one chunk's symbolication is a bad afternoon; losing the whole
  // build's because one chunk was large is a bad week, and that is what throwing here used to do.
  for (const entry of oversized) {
    warn(`WARNING: ${entry.name} is ${mb(entry.bytes)}, over the ${mb(MAX_FILE_BYTES)} per-file limit — skipped.`);
  }

  const base = { skipped, injected, oversized: oversized.length, empty: blank, duplicates, warnings };

  if (indexed.length === 0) {
    // The single most common way this package does nothing useful, and it used to say nothing at
    // all: a bundler with source maps switched off produces a directory full of chunks and not
    // one map, which looks from here exactly like a directory with nothing in it.
    if (skipped > 0) {
      warn(
        `WARNING: found ${skipped} JavaScript file(s) under ${root} and no source maps. ` +
          'Nothing can be symbolicated without them — turn source maps on in your bundler ' +
          "(Vite `build.sourcemap`, webpack `devtool: 'source-map'`, esbuild `--sourcemap`).",
      );
    }
    const summary = nothing(base);
    summarise(log, summary);

    return summary;
  }

  const uninjected = indexed.filter((item) => !item.entry.injected);

  for (const { entry } of indexed) {
    log(`  ${entry.name}`);
    log(`    served as  ${normalise(entry.url)}`);
    log(`    debug id   ${entry.debugId}${entry.injected ? '' : '   (not in the chunk)'}`);
  }

  // Loud on purpose. With `--no-inject` this is the one thing that decides whether these maps
  // will resolve frames from a CDN-rewritten path, and it is easy to get here by running the
  // upload on a machine that never ran `inject`.
  if (uninjected.length > 0 && !options.dryRun) {
    warn('');
    for (const { entry } of uninjected) {
      warn(`WARNING: ${entry.name.replace(/\.map$/, '')} has no debug id. Run without --no-inject, or run "sourcemaps inject" on the build first.`);
    }
    warn(`${uninjected.length} chunk(s) have no debug id; frames from them will only match by release + url.`);
  }

  if (options.dryRun) {
    const bytes = indexed.reduce((total, item) => total + item.entry.bytes, 0);
    log('');
    log(`Dry run: ${indexed.length} map(s), ${mb(bytes)}. Nothing was uploaded.`);

    return {
      ...base,
      stored: 0,
      uploaded: 0,
      alreadyStored: 0,
      bytes,
      uninjected: uninjected.length,
      storedMaps: [],
    };
  }

  const stored = (items: ReadonlyArray<{ artifact: Artifact; entry: UploadEntry }>): StoredMap[] =>
    items
      .filter((item): item is { artifact: Artifact & { map: string }; entry: UploadEntry } => item.artifact.map !== null)
      .map((item) => ({ map: item.artifact.map, chunk: item.artifact.file, sha256: item.entry.mapSha256 }));

  const { stored: already, limits } = await preflight(options, indexed.map((item) => item.entry.sha256));

  // The server's own ceiling, which can be smaller than the protocol's: the same deployment
  // advertises a 20 MiB limit and a 2 MiB `upload_max_filesize`, and only one of those is true of
  // the socket. A part over it is dropped in silence, so it is worth saying here instead.
  const overPart = limits === null ? [] : indexed.filter((item) => item.entry.bytes > limits.maxPartBytes);
  for (const item of overPart) {
    warn(
      `WARNING: ${item.entry.name} is ${mb(item.entry.bytes)} and this server accepts ${mb(limits!.maxPartBytes)} per file — skipped.`,
    );
  }

  const accepted = overPart.length === 0 ? indexed : indexed.filter((item) => !overPart.includes(item));
  const pending = accepted.filter((item) => !already.has(item.entry.sha256));
  const alreadyStored = accepted.length - pending.length;

  if (alreadyStored > 0) {
    log(`${alreadyStored} map(s) are already on the server and were not sent again.`);
  }

  if (pending.length === 0) {
    const summary: UploadSummary = {
      ...base,
      oversized: oversized.length + overPart.length,
      stored: 0,
      uploaded: 0,
      alreadyStored,
      bytes: 0,
      uninjected: uninjected.length,
      storedMaps: stored(accepted),
    };
    summarise(log, summary);

    return summary;
  }

  const groups = batch(pending, limits);
  const bytes = pending.reduce((total, item) => total + item.entry.bytes, 0);
  const sent: Array<{ artifact: Artifact; entry: UploadEntry }> = [];
  let done = 0;
  let count = 0;

  try {
    const results = await pooled(groups, options.concurrency ?? limits?.concurrency ?? DEFAULT_CONCURRENCY, async (group) => {
      // Bodies are read here, not held from the index pass: one batch's worth of maps is in memory
      // at a time, whatever the size of the build.
      const loaded = await Promise.all(
        group.map(async (item) => ({ entry: item.entry, body: await materialise(item.artifact, options) })),
      );

      const result = await send(options, loaded, limits);
      sent.push(...group);
      done += 1;
      if (groups.length > 1) log(`Uploaded ${done} of ${groups.length} batches.`);

      return result;
    });

    count = results.reduce((total, result) => total + result.stored, 0);
  } catch (error) {
    // Whatever did land is still on the server, and the caller may still delete those maps. The
    // summary says how far it got before saying why it stopped.
    summarise(log, {
      ...base,
      oversized: oversized.length + overPart.length,
      stored: count,
      uploaded: sent.length,
      alreadyStored,
      bytes,
      uninjected: uninjected.length,
      storedMaps: stored([...accepted.filter((item) => already.has(item.entry.sha256)), ...sent]),
    });

    throw error;
  }

  const summary: UploadSummary = {
    ...base,
    oversized: oversized.length + overPart.length,
    stored: count,
    uploaded: pending.length,
    alreadyStored,
    bytes,
    uninjected: uninjected.length,
    storedMaps: stored(accepted),
  };
  summarise(log, summary);

  return summary;
}

/** One line, always, so the last thing printed says what happened rather than what went wrong. */
function summarise(log: (line: string) => void, summary: UploadSummary): void {
  const parts = [`${summary.uploaded} uploaded`];
  if (summary.uploaded > 0 && summary.stored < summary.uploaded) parts.push(`${summary.stored} new`);
  if (summary.alreadyStored > 0) parts.push(`${summary.alreadyStored} already stored`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} without maps`);
  if (summary.empty > 0) parts.push(`${summary.empty} empty`);
  if (summary.duplicates > 0) parts.push(`${summary.duplicates} duplicate ids`);
  if (summary.oversized > 0) parts.push(`${summary.oversized} oversized`);

  log('');
  log(`Source maps: ${parts.join(', ')}.`);
}

function nothing(partial: {
  skipped: number;
  injected: number;
  oversized: number;
  empty: number;
  duplicates: number;
  warnings: string[];
}): UploadSummary {
  return {
    ...partial,
    stored: 0,
    uploaded: 0,
    alreadyStored: 0,
    bytes: 0,
    uninjected: 0,
    storedMaps: [],
  };
}
