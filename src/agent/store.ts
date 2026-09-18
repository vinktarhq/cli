import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where a signed-in session lives between runs.
 *
 * One file, keyed by the MCP address, so a staging and a production login do not overwrite each
 * other. It holds a refresh token, which is as good as a password to the workspace it was granted
 * for, so the file is created 0600 and written by rename, never in place: a crash halfway through
 * a write must not leave a truncated file that the next run reads as "signed out" and then clobbers.
 */

export interface Session {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string | null;
  readonly scope: string;
}

/** What is remembered per address even while signed out: the registered client, reused on login. */
export interface Remembered {
  readonly clientId?: string;
  readonly session?: Session;
}

type File = Record<string, Remembered>;

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(homedir(), '.config');

  return env.VINKTAR_CREDENTIALS && env.VINKTAR_CREDENTIALS !== ''
    ? env.VINKTAR_CREDENTIALS
    : join(base, 'vinktar', 'credentials.json');
}

async function readAll(path: string): Promise<File> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));

    return parsed !== null && typeof parsed === 'object' ? (parsed as File) : {};
  } catch {
    return {};
  }
}

export async function load(mcpUrl: string, path = credentialsPath()): Promise<Remembered> {
  return (await readAll(path))[mcpUrl] ?? {};
}

export async function save(mcpUrl: string, value: Remembered, path = credentialsPath()): Promise<void> {
  const all = await readAll(path);
  all[mcpUrl] = value;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  // rename keeps the temp file's mode, but an existing file from an older version may not have had
  // it; set it again rather than trust that.
  await chmod(path, 0o600);
}
