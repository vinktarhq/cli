import { describe, expect, it } from 'vitest';

import {
  MARKER_GLOBAL,
  REGISTRY_GLOBAL,
  commentDebugId,
  deriveDebugId,
  existingDebugId,
  inject,
  injectIntoMap,
  insertionOffset,
  registrationSnippet,
  setDebugIdComment,
  shiftMappings,
  snippetCount,
} from '../src/debug-id.js';

const ID = 'b2b1f8b1-0f3e-4a51-9a1e-7c0d9b2e1f44';

describe('deriveDebugId', () => {
  it('is deterministic, so rebuilding unchanged source keeps the same id', () => {
    expect(deriveDebugId('console.log(1)')).toBe(deriveDebugId('console.log(1)'));
  });

  it('changes when the code changes', () => {
    expect(deriveDebugId('console.log(1)')).not.toBe(deriveDebugId('console.log(2)'));
  });

  it('is a well-formed uuid, because the server stores it in a bounded column', () => {
    expect(deriveDebugId('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('inject', () => {
  it('puts the debugId comment BEFORE sourceMappingURL', () => {
    // Tooling expects sourceMappingURL to be the last line. The previous CLI appended after it,
    // quietly breaking source-map resolution in some devtools while trying to improve it.
    const { code } = inject('const a = 1;\n//# sourceMappingURL=app.js.map\n', ID);

    expect(code.indexOf('//# debugId=')).toBeLessThan(code.indexOf('//# sourceMappingURL='));
    expect(code.trimEnd().endsWith('//# sourceMappingURL=app.js.map')).toBe(true);
  });

  it('appends the comment when there is no sourceMappingURL', () => {
    expect(inject('const a = 1;\n', ID).code).toContain(`//# debugId=${ID}`);
  });

  it('is idempotent: a second run finds the existing id and changes nothing', () => {
    const once = inject('const a = 1;\n', deriveDebugId('const a = 1;\n')).code;
    const twice = inject(once, deriveDebugId('const a = 1;\n')).code;

    expect(twice).toBe(once);
    expect(snippetCount(twice)).toBe(1);
  });

  it('reports no id for an un-injected chunk', () => {
    expect(existingDebugId('const a = 1;')).toBeNull();
  });

  /**
   * The whole reason the snippet moved to the top.
   *
   * Appended, it runs after the module body — so a chunk that throws while initialising registers
   * nothing, and that is precisely the error you most want symbolicated.
   */
  it('puts the snippet at the top, above the code it is registering', () => {
    const { code, line } = inject('const a = 1;\nconst b = 2;\n', ID);

    expect(line).toBe(0);
    expect(code.split('\n')[0]).toContain(REGISTRY_GLOBAL);
  });

  it('stays below a directive prologue, so "use strict" is still a directive', () => {
    const { code, line } = inject('"use strict";\n"use client";\nconst a = 1;\n', ID);
    const lines = code.split('\n');

    expect(line).toBe(2);
    expect(lines[0]).toBe('"use strict";');
    expect(lines[1]).toBe('"use client";');
    expect(lines[2]).toContain(REGISTRY_GLOBAL);
  });

  it('stays below a hashbang, which is only a hashbang on line one', () => {
    const { code, line } = inject('#!/usr/bin/env node\nconst a = 1;\n', ID);

    expect(line).toBe(1);
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(code.split('\n')[1]).toContain(REGISTRY_GLOBAL);
  });

  /**
   * A leading string is a directive only when it is a whole statement. `"undefined"!=typeof x` is
   * an expression that starts with one, and treating it as a prologue would inject into the middle
   * of it — a syntax error in every chunk minified by a tool that emits that idiom, which is all
   * of them.
   */
  it('does not mistake a leading string in an expression for a directive', () => {
    expect(insertionOffset('"undefined"!=typeof window&&init();\n')).toBe(0);
    expect(insertionOffset('"a"\n.trim();\n')).toBe(0);
  });

  it('appends when the prologue does not end at a line boundary, and says so', () => {
    // Minified CJS: the directive and the entire module share one line, so there is no insertion
    // point that neither moves a column nor splits the line. Appending is what this always did.
    const { code, line } = inject('"use strict";var a=1,b=2;', ID);

    expect(line).toBeNull();
    expect(code.startsWith('"use strict";var a=1,b=2;')).toBe(true);
    expect(code).toContain(REGISTRY_GLOBAL);
  });

  it('adds only the missing half when a bundler already wrote the comment', () => {
    // Rollup's own `output.sourcemapDebugIds` writes the comment and the map field and no runtime
    // registration, so the chunk carries a perfectly good id that no stack frame will ever report.
    const { code } = inject(`const a = 1;\n//# debugId=${ID}\n`, ID);

    expect(snippetCount(code)).toBe(1);
    expect(code.match(/\/\/# debugId=/g)).toHaveLength(1);
  });
});

describe('the id survives the tools that run after us', () => {
  it('is readable from the embedded marker once a minifier has stripped the comment', () => {
    // Vite 8 is Rolldown, whose Oxc minifier runs after renderChunk and deletes comments. Without
    // the marker the uploader read no id, derived a fresh one from the minified bytes, and filed
    // the map under an id no stack frame reports.
    const stripped = inject('const a = 1;\n', ID).code.replace(/^\/\/# debugId=.*$/gm, '');

    expect(commentDebugId(stripped)).toBeNull();
    expect(existingDebugId(stripped)).toBe(ID);
  });

  it('can have its comment written back without moving a line', () => {
    const injected = inject('const a = 1;\n', ID).code;
    const stripped = injected.replace(/^\/\/# debugId=.*\n/gm, '');

    expect(setDebugIdComment(stripped, ID).split('\n').length).toBe(injected.split('\n').length);
    expect(existingDebugId(setDebugIdComment(stripped, ID))).toBe(ID);
  });

  it('counts a double stamp, which means the output directory was not cleaned', () => {
    const once = inject('const a = 1;\n', ID).code;

    expect(snippetCount(once)).toBe(1);
    expect(snippetCount(once + once)).toBe(2);
  });
});

describe('the registration snippet', () => {
  it('survives a hostile global scope rather than taking the bundle down', () => {
    // It runs before anything else in the file, so a throw here is a blank page.
    const snippet = registrationSnippet(ID);

    expect(snippet).toContain('try{');
    expect(snippet).toContain('catch(e){}');
  });

  it('registers under the stack, not a filename', () => {
    const snippet = registrationSnippet(ID);

    expect(snippet).toContain('.stack');
    expect(snippet).toContain(REGISTRY_GLOBAL);
  });

  it('json-encodes the id, so an adopted foreign one cannot break out of the literal', () => {
    expect(registrationSnippet('a"; alert(1); //')).toContain('"a\\"; alert(1); //"');
  });

  /**
   * The bug this whole design exists to avoid.
   *
   * The previous CLI keyed the registry on `basename(file)` while the SDK looked up by the frame's
   * `file` — a full URL. `app-DfK29aQx.js` is not `https://cdn.example.com/assets/app-DfK29aQx.js`,
   * so every lookup missed and silently fell through to shipping every id it knew.
   *
   * Running the snippet here proves the key is a real stack containing this file's own location,
   * which is the same shape a runtime error frame has.
   */
  it('keys on a stack whose bottom frame is the running file', () => {
    const scope = run(registrationSnippet(ID));

    const registry = scope[REGISTRY_GLOBAL] as Record<string, string>;
    const keys = Object.keys(registry);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('Error');
    expect(registry[keys[0]!]).toBe(ID);
  });

  it('also leaves the id as a plain string, which is what survives a minifier', () => {
    expect(run(registrationSnippet(ID))[MARKER_GLOBAL]).toBe(`vinktar-dbid-${ID}`);
  });

  /**
   * `new e.Error`, not `new Error`. A bundle that shadows `Error` — a polyfill, a subclass hoisted
   * into scope, a minifier reusing the name — otherwise produces no usable stack and the chunk
   * registers nothing at all, silently.
   */
  it('reads Error off the global, so a bundle that shadows Error still registers', () => {
    const Broken = function Broken(this: unknown) {
      // No `stack`: exactly what a hand-rolled Error subclass gives you.
    } as unknown as ErrorConstructor;

    const scope = run(registrationSnippet(ID), Broken);

    expect(Object.keys(scope[REGISTRY_GLOBAL] as Record<string, string>)).toHaveLength(1);
  });
});

/**
 * Evaluate a snippet against a scope that is not the test runner's own global.
 *
 * Every name the snippet probes is shadowed by a parameter, because `global` really is defined in
 * a Node test process: without the shadow the snippet would find it, register there, and the
 * assertions would read an empty object and pass for the wrong reason.
 */
function run(snippet: string, shadowedError?: ErrorConstructor): Record<string, unknown> {
  const scope: Record<string, unknown> = { Error };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'global', 'globalThis', 'self', 'Error', snippet)(
    scope,
    scope,
    scope,
    scope,
    shadowedError ?? Error,
  );

  return scope;
}

describe('injectIntoMap', () => {
  it('writes the id into the map so the server can find it without debug_ids[]', () => {
    const out = injectIntoMap('{"version":3,"sources":["a.ts"]}', ID);

    expect(JSON.parse(out)).toMatchObject({ version: 3, debugId: ID, debug_id: ID });
  });

  it('keeps every field the bundler wrote', () => {
    const out = JSON.parse(injectIntoMap('{"version":3,"mappings":"AAAA","names":[],"x_google_ignoreList":[0]}', ID));

    expect(out).toMatchObject({ version: 3, mappings: 'AAAA', names: [], x_google_ignoreList: [0] });
  });

  it('refuses a map that is not an object rather than writing nonsense', () => {
    expect(() => injectIntoMap('[]', ID)).toThrow();
  });
});

/**
 * The exact repair for a prepended line.
 *
 * `mappings` is one `;`-separated group per generated line, and an empty group contributes no
 * segments and therefore no deltas — so splicing one in translates every following line by exactly
 * one and moves no column. That is the whole reason the snippet goes in as a full line rather than
 * inline, which is what forces both incumbents to depend on magic-string.
 */
describe('shiftMappings', () => {
  it('splices one empty group at the insertion line', () => {
    expect(shiftMappings({ mappings: 'AAAA;BBBB;CCCC' }, 0)['mappings']).toBe(';AAAA;BBBB;CCCC');
    expect(shiftMappings({ mappings: 'AAAA;BBBB;CCCC' }, 2)['mappings']).toBe('AAAA;BBBB;;CCCC');
  });

  it('moves an indexed map by its section offsets instead', () => {
    const shifted = shiftMappings(
      { sections: [{ offset: { line: 0, column: 0 } }, { offset: { line: 5, column: 0 } }] },
      1,
    );

    expect(shifted['sections']).toEqual([{ offset: { line: 0, column: 0 } }, { offset: { line: 6, column: 0 } }]);
  });

  it('is applied by injectIntoMap when a line was inserted', () => {
    const out = JSON.parse(injectIntoMap('{"version":3,"mappings":"AAAA;BBBB"}', ID, 0));

    expect(out.mappings).toBe(';AAAA;BBBB');
  });

  it('leaves the mappings alone when the snippet was appended', () => {
    const out = JSON.parse(injectIntoMap('{"version":3,"mappings":"AAAA;BBBB"}', ID, null));

    expect(out.mappings).toBe('AAAA;BBBB');
  });
});

describe('a bundle with more than one sourceMappingURL', () => {
  it("anchors the comment on the last one, so an input file's stale comment is left alone", () => {
    const code = 'a();\n//# sourceMappingURL=old.js.map\nb();\n//# sourceMappingURL=bundle.js.map\n';
    const lines = inject(code, ID).code.trimEnd().split('\n');

    expect(lines.at(-1)).toBe('//# sourceMappingURL=bundle.js.map');
    expect(lines.at(-2)).toBe(`//# debugId=${ID}`);
  });
});
