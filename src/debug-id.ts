import { createHash } from 'node:crypto';

/**
 * Debug IDs tie a built file to its source map without depending on a release name or a URL.
 *
 * The SDK reads them from a global registry at capture time and sends one per frame; the server
 * matches on that before falling back to `(release, url)`. It is the only mechanism that survives
 * a CDN rewriting paths, a build being served from two origins, or a release string being wrong.
 *
 * ## Why the registry is keyed on a stack, not a filename
 *
 * The obvious implementation registers under the file's basename. The previous CLI did exactly
 * that, and it never matched a single frame: the SDK looks up by the frame's `file`, which is a
 * full URL like `https://cdn.example.com/assets/app-DfK29aQx.js`, and `app-DfK29aQx.js` is not
 * that string. Every lookup silently fell through to the "ship every id we know" fallback.
 *
 * Keying on `new Error().stack` fixes it at the root. The snippet runs INSIDE the chunk, so the
 * bottom frame of that stack is the chunk's own URL exactly as the browser resolved it — the same
 * bytes that will appear in an error frame later. The SDK parses the key with the same stack
 * parser it uses on real errors, so the two sides cannot disagree about what a URL looks like.
 *
 * It is also the only approach that works across ESM, CJS and IIFE at once:
 * `document.currentScript` is null in module scripts, and `import.meta.url` is a syntax error
 * outside ESM.
 */

/** The global the SDK reads. Changing it breaks every already-deployed bundle. */
export const REGISTRY_GLOBAL = '_vinktarDebugIds';

/**
 * A second global holding the id as a plain string literal.
 *
 * The `//# debugId=` comment is the documented place to read an id from, and it is also the first
 * thing a minifier deletes. Vite 8 is Rolldown, whose Oxc minifier runs AFTER `renderChunk` and
 * strips comments while leaving the snippet intact — so the uploader read no id, derived a fresh
 * one from the minified bytes, and filed the map under an id no stack frame would ever report.
 * A string literal inside executable code survives every minifier, every banner plugin and every
 * downstream rewrite, which makes this the durable copy and the comment the convenient one.
 */
export const MARKER_GLOBAL = '_vinktarDebugIdIdentifier';

const MARKER_PREFIX = 'vinktar-dbid-';

/** The shape a debug id must have to be trusted when it came from somewhere else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDebugId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A stable id for a chunk, derived from its bytes.
 *
 * Deterministic on purpose: rebuilding unchanged source produces the same id, so re-uploading is
 * idempotent and a cache-busting filename change does not orphan a map.
 *
 * Derived from the CODE ONLY, never the map. A comment-only edit to a source file rewrites the
 * map's `sourcesContent` while the compiled chunk stays byte-identical, and an id that changed
 * there would re-upload the whole build for nothing.
 *
 * Formatted as a UUID because the server stores it in a 64-char column and a UUID is what every
 * other tool in this space produces, which makes it recognisable in a payload.
 */
export function deriveDebugId(code: string): string {
  const hex = createHash('sha256').update(code).digest('hex').slice(0, 32);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Version and variant nibbles, so it is a well-formed UUIDv4-shaped string rather than
    // something that merely looks like one.
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The code injected into a chunk.
 *
 * Every detail here is load-bearing, and all of them are shared with the two tools that have run
 * this in production for years:
 *
 * - **`typeof` guards, `window → global → globalThis → self → {}`.** A bare `globalThis` is a
 *   ReferenceError on an engine that lacks it, and the throw happens inside the try, so the id is
 *   silently lost rather than loudly broken.
 * - **`new e.Error`, not `new Error`.** A bundle that shadows `Error` — a polyfill, a subclass
 *   hoisted into scope, a minifier reusing the name — otherwise produces no usable stack and the
 *   chunk registers nothing.
 * - **ES5 `var` and `!function(){}()`.** `let` breaks any bundle still targeting a legacy engine,
 *   and the leading `!` makes the expression safe to concatenate after any statement.
 * - **`n&&(…)`.** An engine that gives no stack must not throw on a property access.
 * - **A JSON-encoded id.** Ids adopted from another bundler are attacker-adjacent input as far as
 *   this string literal is concerned, and one containing a quote would otherwise break out of it.
 * - **try/catch around everything.** It runs before the rest of the file: a throw here is a blank
 *   page, and a missing debug id is worth far less than a working page.
 */
export function registrationSnippet(debugId: string): string {
  const id = JSON.stringify(debugId);

  return (
    `!function(){try{var e="undefined"!=typeof window?window:` +
    `"undefined"!=typeof global?global:` +
    `"undefined"!=typeof globalThis?globalThis:` +
    `"undefined"!=typeof self?self:{};` +
    `var n=(new e.Error).stack;` +
    `n&&(e.${REGISTRY_GLOBAL}=e.${REGISTRY_GLOBAL}||{},e.${REGISTRY_GLOBAL}[n]=${id},` +
    `e.${MARKER_GLOBAL}=${JSON.stringify(MARKER_PREFIX + debugId)})}catch(e){}}();`
  );
}

/** The comment tools read the id from, and the one a minifier is free to delete. */
export function debugIdComment(debugId: string): string {
  return `//# debugId=${debugId}`;
}

const DEBUG_ID_COMMENT = /^\/\/# debugId=(.+)$/gm;
const SOURCE_MAPPING_COMMENT = /^\/\/[#@] sourceMappingURL=.*$/gm;
const MARKER = new RegExp(`${MARKER_GLOBAL}\\s*=\\s*["']${MARKER_PREFIX}([0-9a-fA-F-]{36})["']`);

/**
 * The id a chunk already carries, from the comment first and the embedded marker second.
 *
 * Line-anchored, and the LAST match wins: the string `//# debugId=` can appear inside a bundled
 * string literal — a tool that generates this very snippet, bundled into an application — and
 * matching it there would adopt an id belonging to nothing.
 */
export function existingDebugId(code: string): string | null {
  return commentDebugId(code) ?? MARKER.exec(code)?.[1] ?? null;
}

/** Only the comment. Separate because a chunk can carry one without the other — see {@link inject}. */
export function commentDebugId(code: string): string | null {
  let comment: RegExpExecArray | null = null;
  for (const match of code.matchAll(DEBUG_ID_COMMENT)) comment = match;

  const value = comment?.[1]?.trim();

  return value === undefined || value === '' ? null : value;
}

/** Whether the chunk carries the runtime registration, as opposed to merely a comment about it. */
export function hasSnippet(code: string): boolean {
  return code.includes(REGISTRY_GLOBAL);
}

/**
 * How many registrations a chunk carries. One is right; more means it was stamped twice.
 *
 * Counted on the marker global, which appears exactly once per snippet — the registry global
 * appears three times in one, so counting that would report every chunk as triple-stamped. Two
 * snippets is not harmless: the second registers the id derived from bytes that already contained
 * the first, so the chunk claims an id its map was never filed under.
 */
export function snippetCount(code: string): number {
  return code.split(MARKER_GLOBAL).length - 1;
}

/**
 * Where the snippet may be inserted, as a character offset that is also a line boundary.
 *
 * Two things must stay in front of it. A `#!` hashbang is only a hashbang on line one, and a
 * directive prologue (`"use strict"`, `"use client"`) is only a directive while nothing precedes
 * it — injecting above one silently demotes it to a no-op expression, which turns strict mode off
 * for the whole chunk.
 *
 * Returns `null` when the prologue does not end at a line boundary, which is the minified-CJS
 * case: `"use strict";var a=1,…` puts the entire chunk on the directive's line, so there is no
 * insertion point that neither moves a column nor splits the line. The caller appends instead —
 * exactly what this package did everywhere before — and the map stays untouched.
 */
export function insertionOffset(code: string): number | null {
  let offset = 0;

  if (code.startsWith('#!')) {
    const newline = code.indexOf('\n');
    if (newline === -1) return null;
    offset = newline + 1;
  }

  for (;;) {
    const rest = code.slice(offset);

    // Whitespace and comments are not statements: stepping over them cannot demote a directive.
    const skip = /^(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/.exec(rest);
    if (skip !== null) {
      offset += skip[0].length;
      continue;
    }

    // A leading string is a directive only when it is a complete statement. `"undefined"!=typeof x`
    // and `"a"\n.trim()` are expressions, and treating either as a prologue would inject into the
    // middle of one and produce a syntax error.
    const directive = /^(?:"[^"\\\n]*"|'[^'\\\n]*')\s*;/.exec(rest);
    if (directive !== null) {
      offset += directive[0].length;
      continue;
    }

    break;
  }

  if (offset === 0) return 0;

  return code[offset - 1] === '\n' ? offset : null;
}

export interface Injection {
  readonly code: string;
  /**
   * The generated line the snippet occupies, 0-based, or `null` when it was appended and no line
   * moved. The map must gain one empty group at this index — see {@link shiftMappings}.
   */
  readonly line: number | null;
}

/**
 * Inject the snippet and the `//# debugId=` comment.
 *
 * The snippet goes as close to the TOP as it can, so a chunk that throws while initialising still
 * registers its id — which is the case where symbolication is most wanted and where appending
 * gives you nothing. It is inserted as a whole line at a line boundary, so every following line
 * shifts by exactly one and no column moves anywhere; that is what makes the map repairable with
 * {@link shiftMappings} instead of a source-map library — which is what lets this package prepend
 * without the magic-string dependency the same trick usually costs.
 *
 * The comment goes at the end, BEFORE `//# sourceMappingURL=`, which is the order Rollup itself
 * emits for `output.sourcemapDebugIds`. Browsers and every tool that reads a bundle expect
 * `sourceMappingURL` to be last; an earlier version of this package appended after it and quietly
 * broke source-map resolution in some devtools while trying to improve it.
 */
export interface InjectOptions {
  /**
   * Put the snippet at the top. Default true.
   *
   * Set false where a later stage will re-derive the chunk's sourcemap from the code we hand it —
   * Rolldown's Oxc minifier does exactly that, running after `renderChunk` — because there is then
   * no hook between the insertion and the composition in which to account for the line. Appending
   * moves nothing, so nothing needs accounting for. See {@link Injection.line}.
   */
  readonly prepend?: boolean;
}

export function inject(code: string, debugId: string, options: InjectOptions = {}): Injection {
  let line: number | null = null;
  let result = code;

  // Idempotent per part, because the two halves genuinely arrive separately. Rollup's own
  // `output.sourcemapDebugIds` writes the comment and the map field and NO runtime registration,
  // so a chunk can carry a perfectly good id that no stack frame will ever report. Adopting that
  // id and adding only the missing snippet keeps the map that is already filed under it.
  if (!hasSnippet(result)) {
    const snippet = registrationSnippet(debugId);
    const offset = options.prepend === false ? null : insertionOffset(result);

    if (offset === null) {
      result = `${result}\n${snippet}\n`;
    } else {
      // Lines before the insertion point are exactly the newlines before it.
      line = countNewlines(result.slice(0, offset));
      result = `${result.slice(0, offset)}${snippet}\n${result.slice(offset)}`;
    }
  }

  return { code: setDebugIdComment(result, debugId), line };
}

/**
 * Put the `//# debugId=` comment in its place, replacing whatever was there.
 *
 * Separate from {@link inject} because it is also the repair: Rolldown's minifier runs after the
 * chunk has been stamped and deletes the comment, so it has to be written back into an already
 * injected chunk without touching the snippet or moving a single line.
 */
export function setDebugIdComment(code: string, debugId: string): string {
  if (commentDebugId(code) === debugId) return code;

  return withComment(stripComment(code), debugIdComment(debugId));
}

/** Remove a stale `//# debugId=` line, so replacing an id cannot leave two of them behind. */
function stripComment(code: string): string {
  return code.replace(/^\/\/# debugId=.*\n?/gm, '');
}

/**
 * Place the comment before a TRAILING `sourceMappingURL`, and otherwise at the very end.
 *
 * The last one, not the first: a concatenated bundle can carry an earlier `sourceMappingURL` from
 * one of its inputs. And only when nothing but whitespace follows it, because inserting a line
 * ahead of a mapping comment that still has code after it would shift every line below it and
 * corrupt the map this is all in aid of.
 */
function withComment(code: string, comment: string): string {
  let mapping: RegExpExecArray | null = null;
  for (const match of code.matchAll(SOURCE_MAPPING_COMMENT)) mapping = match;

  if (mapping?.index === undefined || code.slice(mapping.index + mapping[0].length).trim() !== '') {
    return code.endsWith('\n') ? `${code}${comment}\n` : `${code}\n${comment}\n`;
  }

  return `${code.slice(0, mapping.index)}${comment}\n${code.slice(mapping.index)}`;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1;

  return count;
}

/**
 * Move every mapping down by one generated line, to account for an inserted line.
 *
 * `mappings` is a `;`-separated list with one group per generated line, and a group's segments
 * carry deltas that continue across lines. An EMPTY group contributes no segments and therefore no
 * deltas, so splicing one in is an exact translation rather than an approximation — which is why
 * the snippet is inserted as a whole line and never inline.
 *
 * Indexed maps carry no top-level `mappings`; their `sections` are positioned by an offset, so the
 * same shift is applied there. The server does not symbolicate indexed maps today, but corrupting
 * one is not the way to say so.
 */
export function shiftMappings(map: Record<string, unknown>, atLine: number): Record<string, unknown> {
  if (Array.isArray(map['sections'])) {
    return {
      ...map,
      sections: map['sections'].map((section: unknown) => {
        const offset = (section as { offset?: { line?: unknown; column?: unknown } })?.offset;
        const line = typeof offset?.line === 'number' ? offset.line : null;
        if (line === null || line < atLine) return section;

        return { ...(section as object), offset: { ...offset, line: line + 1 } };
      }),
    };
  }

  if (typeof map['mappings'] !== 'string') return map;

  const groups = map['mappings'].split(';');
  groups.splice(Math.min(atLine, groups.length), 0, '');

  return { ...map, mappings: groups.join(';') };
}

/**
 * Write the id into the map, and shift it when a line was inserted above the code.
 *
 * The id goes in as both `debugId` and `debug_id`: the first is what every bundler emitting these
 * natively writes today, the second is what the server also accepts, and which of the two becomes
 * the standard is not settled. Every other key is preserved untouched — `sections`, `ignoreList`
 * and any `x_` extension a toolchain added mean something to somebody.
 */
export function injectIntoMap(mapJson: string, debugId: string, shiftAtLine: number | null = null): string {
  const parsed: unknown = JSON.parse(mapJson);

  // `typeof [] === 'object'`, so the array check is not redundant: without it a malformed map
  // would be spread into `{0: …, debugId: …}` and uploaded as nonsense.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('source map is not a JSON object');
  }

  const map = parsed as Record<string, unknown>;
  const shifted = shiftAtLine === null ? map : shiftMappings(map, shiftAtLine);

  return JSON.stringify({ ...shifted, debugId, debug_id: debugId });
}

/** The id a map already carries, when it is one we can trust. */
export function mapDebugId(mapJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(mapJson);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    const value = record['debugId'] ?? record['debug_id'];

    return isDebugId(value) ? value : null;
  } catch {
    return null;
  }
}
