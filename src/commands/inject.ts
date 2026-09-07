import { readFile, writeFile } from 'node:fs/promises';

import {
  commentDebugId,
  deriveDebugId,
  existingDebugId,
  hasSnippet,
  inject as injectCode,
  injectIntoMap,
  mapDebugId,
  snippetCount,
} from '../debug-id.js';
import { discover, isEmptyMap, type DiscoverOptions } from '../discover.js';

export interface InjectResult {
  /** Chunks stamped by this run. */
  readonly injected: number;
  /** Chunks that already carried everything they needed. */
  readonly skipped: number;
  /** Chunks whose id came from a map another tool had already stamped. */
  readonly adopted: number;
  /** Maps rewritten to carry their chunk's id, because the two disagreed. */
  readonly repaired: number;
  /** Chunks with no map to pair with. */
  readonly withoutMaps: number;
  /** Chunks whose map resolves nothing, so there was no point stamping them. */
  readonly empty: number;
  readonly warnings: string[];
}

/**
 * Stamp every built chunk with a debug id, and write the same id into its map.
 *
 * `upload` runs this itself by default, so the standalone command exists for pipelines that build
 * on one machine and upload from another. It is idempotent: a chunk that already carries an id is
 * left alone, so running it twice, or running it in a build that is partially cached, does not
 * produce duplicate snippets.
 *
 * ## Where the id comes from
 *
 * The chunk first, then the map, then the chunk's bytes. Bundlers stamp maps themselves now —
 * Rollup's `output.sourcemapDebugIds`, webpack 5.104's `debugIds`, esbuild, rolldown — and minting
 * a competing id for a map already filed under one produced exactly the mismatch that `doctor`
 * calls fatal: the SDK reports one id, the server stored the map under another, and nothing
 * resolves. Adopting theirs costs nothing and keeps both sides pointing at the same artifact. The
 * chunk wins over the map when they disagree, because the chunk is what a stack frame comes from.
 */
export async function inject(
  root: string,
  log: (line: string) => void,
  options: DiscoverOptions = {},
): Promise<InjectResult> {
  const { artifacts, warnings } = await discover(root, options);
  let injected = 0;
  let skipped = 0;
  let adopted = 0;
  let repaired = 0;
  let withoutMaps = 0;
  let empty = 0;

  for (const artifact of artifacts) {
    if (artifact.map === null) {
      withoutMaps += 1;
      continue;
    }

    const code = await readFile(artifact.file, 'utf8');
    const rawMap = await readFile(artifact.map, 'utf8');

    if (isEmptyMap(rawMap)) {
      empty += 1;
      continue;
    }

    const fromChunk = existingDebugId(code);
    const fromMap = mapDebugId(rawMap);
    // Derived from the code BEFORE injection, so it stays stable across repeated runs: hashing
    // the injected output would give a different id every time.
    const debugId = fromChunk ?? fromMap ?? deriveDebugId(code);

    const complete = hasSnippet(code) && commentDebugId(code) === debugId;
    if (complete && fromMap === debugId) {
      skipped += 1;
      continue;
    }

    const injection = injectCode(code, debugId);

    if (injection.code !== code) {
      await writeFile(artifact.file, injection.code, 'utf8');
    }
    if (fromMap !== debugId || injection.line !== null) {
      await writeFile(artifact.map, injectIntoMap(rawMap, debugId, injection.line), 'utf8');
    }

    if (complete) {
      // The chunk was fine; its map was filed under something else, or nothing.
      repaired += 1;
    } else {
      injected += 1;
      if (fromChunk === null && fromMap !== null) adopted += 1;
    }

    log(`  ${artifact.relative}  ${debugId}`);
  }

  return { injected, skipped, adopted, repaired, withoutMaps, empty, warnings };
}

export interface AuditEntry {
  readonly relative: string;
  /** The id in the chunk, from its comment or its embedded marker, or null when never injected. */
  readonly chunkId: string | null;
  /** The id in the map's `debugId` field, or null when the map has none (or is not valid JSON). */
  readonly mapId: string | null;
  /** Whether the chunk carries the runtime registration, not merely a comment naming an id. */
  readonly registered: boolean;
  /** How many registrations it carries. More than one means the output was not cleaned. */
  readonly snippets: number;
  /** Whether the map can resolve anything at all. */
  readonly empty: boolean;
  /** Whether the map carries the original source text, without which frames have no context. */
  readonly hasSourcesContent: boolean;
}

export interface AuditResult {
  readonly entries: readonly AuditEntry[];
  /** Chunks (with a map) that carry a debug id. */
  readonly injected: number;
  /** Chunks (with a map) that carry none. */
  readonly notInjected: number;
  /** Chunks whose map does not carry the same id the chunk does. */
  readonly mismatched: number;
  /** Chunks naming an id that nothing will report at runtime. */
  readonly unregistered: number;
  readonly withoutMaps: number;
  readonly warnings: string[];
}

/**
 * Read-only: what `inject` would find. Backs `doctor --dir` and the `--no-inject` warning.
 *
 * "Mismatched" is the dangerous state, not "not injected": a chunk without an id still matches by
 * release and url, but a chunk whose id differs from its map's matches nothing at all, because the
 * SDK reports one id and the server filed the map under another.
 */
export async function audit(root: string, options: DiscoverOptions = {}): Promise<AuditResult> {
  const { artifacts, warnings } = await discover(root, options);
  const entries: AuditEntry[] = [];
  let withoutMaps = 0;

  for (const artifact of artifacts) {
    if (artifact.map === null) {
      withoutMaps += 1;
      continue;
    }

    const code = await readFile(artifact.file, 'utf8');
    const rawMap = await readFile(artifact.map, 'utf8');

    let hasSourcesContent = false;
    try {
      const map: unknown = JSON.parse(rawMap);
      const content = (map as Record<string, unknown> | null)?.['sourcesContent'];
      hasSourcesContent = Array.isArray(content) && content.some((entry) => typeof entry === 'string');
    } catch {
      // Not JSON: treated as carrying no id and no sources, which the counts then report.
    }

    entries.push({
      relative: artifact.relative,
      chunkId: existingDebugId(code),
      mapId: mapDebugId(rawMap),
      registered: hasSnippet(code),
      snippets: snippetCount(code),
      empty: isEmptyMap(rawMap),
      hasSourcesContent,
    });
  }

  const injected = entries.filter((entry) => entry.chunkId !== null).length;
  const mismatched = entries.filter((entry) => entry.chunkId !== null && entry.mapId !== entry.chunkId).length;
  const unregistered = entries.filter((entry) => entry.chunkId !== null && !entry.registered).length;

  return {
    entries,
    injected,
    notInjected: entries.length - injected,
    mismatched,
    unregistered,
    withoutMaps,
    warnings,
  };
}
