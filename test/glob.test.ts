import { describe, expect, it } from 'vitest';

import { compile, matches } from '../src/glob.js';

describe('the glob matcher', () => {
  it('keeps * inside one path segment and lets ** cross them', () => {
    expect(compile('*.js').test('app.js')).toBe(true);
    expect(compile('*.js').test('a/app.js')).toBe(false);
    expect(compile('**/*.js').test('a/b/app.js')).toBe(true);
  });

  it('lets a/**/b match a/b, because the separator belongs to the **', () => {
    expect(compile('a/**/b.js').test('a/b.js')).toBe(true);
    expect(compile('a/**/b.js').test('a/x/y/b.js')).toBe(true);
  });

  it('handles classes and alternation', () => {
    expect(compile('app.[jt]s').test('app.ts')).toBe(true);
    expect(compile('app.[!j]s').test('app.js')).toBe(false);
    expect(compile('*.{js,mjs}').test('app.mjs')).toBe(true);
    expect(compile('*.{js,mjs}').test('app.css')).toBe(false);
  });

  it('treats a regex metacharacter as a literal, not as a pattern', () => {
    // The failure this avoids is silent: `.` matching any character means `--ignore app.js` also
    // ignores `appxjs`, and nobody ever notices.
    expect(compile('app.js').test('appxjs')).toBe(false);
    expect(compile('a+b.js').test('a+b.js')).toBe(true);
    expect(compile('(x).js').test('(x).js')).toBe(true);
  });

  /**
   * The usual implementation chains `String.replace` calls, and gets this wrong every time: the
   * `*` rule rewrites the output of the `**` rule.
   */
  it('does not let one rule rewrite another rule\'s output', () => {
    expect(compile('**').test('a/b/c.js')).toBe(true);
    expect(compile('a/**').test('a/b/c.js')).toBe(true);
  });
});

describe('matching a build path', () => {
  it('matches a bare pattern against the basename too', () => {
    expect(matches('assets/app.min.js', ['*.min.js'])).toBe(true);
    expect(matches('assets/app.js', ['*.min.js'])).toBe(false);
  });

  it('treats a directory name as everything under it', () => {
    expect(matches('vendor/lib/a.js', ['vendor'])).toBe(true);
    expect(matches('vendor/lib/a.js', ['vendor/'])).toBe(true);
    expect(matches('vendors/lib/a.js', ['vendor'])).toBe(false);
  });

  it('compares with forward slashes whatever the platform wrote', () => {
    expect(matches('assets\\app.js', ['assets/*.js'])).toBe(true);
  });

  it('is false for no patterns at all', () => {
    expect(matches('a.js', [])).toBe(false);
  });
});
