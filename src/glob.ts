/**
 * A glob matcher, hand-rolled.
 *
 * `--ignore` needs one, and every candidate dependency costs more than it is worth here: this
 * package ships zero runtime dependencies, and the one library that would do it without pulling a
 * tree behind it (`picomatch`) is still a download on every `npx` invocation, on every CI run.
 * `node:fs`'s own glob support arrived in Node 22, which would move the supported floor from 18
 * for a feature nobody upgrades Node for.
 *
 * Supported, which is the intersection of what a build output needs and what people actually
 * write: `*` (anything but `/`), `**` (anything, including `/`), `?` (one character but `/`),
 * `[abc]` and `[!abc]` classes, and `{a,b}` alternation. Brace nesting is one level, because a
 * pattern that needs two is a pattern nobody will read twice.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Compile a glob to a RegExp anchored at both ends.
 *
 * Written as a single left-to-right scan rather than a chain of `String.replace` calls, which is
 * the usual shape and is wrong for the same reason every time: an earlier replacement's output
 * becomes a later one's input, so `**` is rewritten by the `*` rule and a `\*` escape is honoured
 * by whichever rule happens to run last.
 */
export function compile(pattern: string): RegExp {
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === '*') {
      const double = pattern[i + 1] === '*';
      if (double) {
        i += 1;
        // `a/**/b` must also match `a/b`: the separator after `**` is part of what it consumes.
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
          continue;
        }
        source += '.*';
        continue;
      }
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      const body = pattern.slice(i + 1, end);
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
      continue;
    }

    if (char === '{') {
      const end = pattern.indexOf('}', i + 1);
      if (end === -1) {
        source += '\\{';
        continue;
      }
      const options = pattern.slice(i + 1, end).split(',');
      source += `(?:${options.map((option) => compile(option).source.slice(1, -1)).join('|')})`;
      i = end;
      continue;
    }

    source += char.replace(SPECIAL, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

/**
 * Whether a path matches any of the patterns.
 *
 * A bare pattern with no `/` is matched against the basename as well as the whole path, because
 * `--ignore '*.min.js'` means "any minified file", not "a minified file at the root" — and being
 * told the flag did nothing is not the same as being told why.
 *
 * Paths are compared with forward slashes, always: the patterns people write come from a shell or
 * a config file and never contain backslashes, whatever platform they run on.
 */
export function matches(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;

  const target = path.split('\\').join('/');
  const base = target.slice(target.lastIndexOf('/') + 1);

  return patterns.some((pattern) => {
    const expression = compiled(pattern);

    if (expression.test(target)) return true;
    if (!pattern.includes('/') && expression.test(base)) return true;

    // A directory pattern covers everything under it: `--ignore vendor` should not need
    // `vendor/**` as well, which is the first thing anyone gets wrong.
    return compiled(pattern.endsWith('/') ? `${pattern}**` : `${pattern}/**`).test(target);
  });
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  const found = cache.get(pattern);
  if (found !== undefined) return found;

  const expression = compile(pattern);
  cache.set(pattern, expression);

  return expression;
}
