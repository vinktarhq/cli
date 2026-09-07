import { readFile } from 'node:fs/promises';

/**
 * Decode one position through a source map, locally.
 *
 * This is the question everybody actually has — "would this frame resolve, and to what" — and
 * without it the only way to answer is to cause a real error in production and look at what comes
 * back. It decodes the same way the server does, deliberately: if the two disagree, one of them is
 * wrong, and this is the one you can run in a loop.
 */

export interface Position {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name: string | null;
  /** The original line's text, when the map carries `sourcesContent`. */
  readonly text: string | null;
}

export interface ResolveResult {
  readonly position: Position | null;
  /** Lines of context around the position, when the source text is available. */
  readonly context: Array<{ line: number; text: string; here: boolean }>;
  readonly debugId: string | null;
  readonly warnings: string[];
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * @param line   1-based, as a stack frame reports it
 * @param column 1-based, as a stack frame reports it
 */
export async function resolvePosition(mapPath: string, line: number, column: number): Promise<ResolveResult> {
  const warnings: string[] = [];
  const raw = await readFile(mapPath, 'utf8');
  const map = JSON.parse(raw) as {
    mappings?: unknown;
    sources?: unknown;
    sourcesContent?: unknown;
    names?: unknown;
    sourceRoot?: unknown;
    sections?: unknown;
    debugId?: unknown;
    debug_id?: unknown;
  };

  const debugId = typeof map.debugId === 'string' ? map.debugId : typeof map.debug_id === 'string' ? map.debug_id : null;

  if (Array.isArray(map.sections)) {
    return {
      position: null,
      context: [],
      debugId,
      warnings: ['This is an indexed source map (it has `sections`), which is not decoded here.'],
    };
  }

  if (typeof map.mappings !== 'string' || map.mappings === '') {
    return { position: null, context: [], debugId, warnings: ['The map has no mappings, so it resolves nothing.'] };
  }

  const sources = Array.isArray(map.sources) ? map.sources : [];
  const names = Array.isArray(map.names) ? map.names : [];
  const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];
  const root = typeof map.sourceRoot === 'string' && map.sourceRoot !== '' ? map.sourceRoot.replace(/\/?$/, '/') : '';

  const found = trace(map.mappings, line - 1, column - 1);
  if (found === null) {
    return {
      position: null,
      context: [],
      debugId,
      warnings: [`Nothing is mapped at line ${line}, column ${column}. The map may belong to a different build.`],
    };
  }

  const source = typeof sources[found.source] === 'string' ? `${root}${String(sources[found.source])}` : '(unknown)';
  const text = typeof contents[found.source] === 'string' ? String(contents[found.source]) : null;
  if (text === null) warnings.push('The map carries no sourcesContent, so there is no source text to show.');

  const lines = text?.split(/\r?\n/) ?? [];
  const context = lines
    .map((value, index) => ({ line: index + 1, text: value, here: index === found.line }))
    .filter((entry) => Math.abs(entry.line - (found.line + 1)) <= 2);

  return {
    position: {
      source,
      line: found.line + 1,
      column: found.column + 1,
      name: found.name === null ? null : (typeof names[found.name] === 'string' ? String(names[found.name]) : null),
      text: lines[found.line] ?? null,
    },
    context,
    debugId,
    warnings,
  };
}

interface Segment {
  readonly generated: number;
  readonly source: number;
  readonly line: number;
  readonly column: number;
  readonly name: number | null;
}

/**
 * Find the segment covering a generated position.
 *
 * The LAST segment at or before the column, not the nearest: a source map names where each run of
 * generated code starts, so a column in the middle of a run belongs to the run that began before
 * it. Searching for the closest instead resolves the second half of every minified line to
 * whatever comes next, which looks plausible and is wrong.
 */
function trace(mappings: string, line: number, column: number): Segment | null {
  const groups = mappings.split(';');
  if (line < 0 || line >= groups.length) return null;

  // The deltas run across the whole map, so every earlier line has to be decoded to know what the
  // values on this one mean.
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  let answer: Segment | null = null;

  for (let index = 0; index <= line; index += 1) {
    let generated = 0;

    for (const field of (groups[index] ?? '').split(',')) {
      if (field === '') continue;

      const values = decode(field);
      if (values.length === 0) continue;

      generated += values[0]!;
      if (values.length < 4) continue;

      source += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      if (values.length > 4) name += values[4]!;

      if (index !== line) continue;
      if (generated > column) continue;

      answer = {
        generated,
        source,
        line: originalLine,
        column: originalColumn,
        name: values.length > 4 ? name : null,
      };
    }
  }

  return answer;
}

/** Base64 VLQ: five data bits per character, the sixth saying whether more follow. */
function decode(field: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;

  for (const character of field) {
    const digit = ALPHABET.indexOf(character);
    if (digit === -1) return [];

    value += (digit & 31) << shift;

    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }

    // The low bit is the sign, which is why this is not a plain shift.
    values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
    shift = 0;
    value = 0;
  }

  return values;
}
