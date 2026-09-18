import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { DEFAULT_MCP_URL, McpClient, type Tool } from '../agent/mcp.js';
import { bounded, REQUEST_TIMEOUT_MS } from '../agent/net.js';
import { authorizeUrl, discover, exchange, listen, pkce, randomState, register, revoke } from '../agent/oauth.js';
import { load, save } from '../agent/store.js';

/**
 * The CLI as a second way in for coding agents.
 *
 * Most agents reach Vinktar over MCP. Some harnesses have no MCP support at all (pi, by design;
 * Aider; a CI job), and for them these commands are the same connection: `vinktar login` runs the
 * same sign-in an editor does, and every other command is one MCP call. So the person picks the
 * same workspace and project on the same consent screen, the agent sees the same tools, and every
 * call counts, is limited and is logged exactly as it would be from an editor.
 *
 * There is no `ask "<question>"`. Vinktar runs no model; the agent calling this CLI is the model.
 * It reads `vinktar tools`, picks one, and runs `vinktar call`.
 */

export interface Io {
  readonly log: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  /** Per request. Shortened in tests; 30 s otherwise. Not the wait for the browser in `login`. */
  readonly timeoutMs?: number;
  /** Replaced in tests; opens the system browser otherwise. */
  readonly open?: (url: string) => void;
  readonly credentials?: string;
}

export const AGENT_COMMANDS = new Set(['login', 'logout', 'tools', 'call', 'guide', 'keys', 'status', 'changes', 'sql', 'agents-md']);

export const AGENTS_MD_BEGIN = '<!-- vinktar:begin -->';
export const AGENTS_MD_END = '<!-- vinktar:end -->';
const AGENTS_MD_URI = 'vinktar://guide/agents-md';

export function mcpUrl(flags: Map<string, string | boolean>, env: NodeJS.ProcessEnv): string {
  const flag = flags.get('mcp');
  if (typeof flag === 'string' && flag !== '') return flag;
  if (env.VINKTAR_MCP_URL && env.VINKTAR_MCP_URL !== '') return env.VINKTAR_MCP_URL;

  return DEFAULT_MCP_URL;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The URL is printed either way; a machine with no browser is not an error.
  }
}

/**
 * `key=value` arguments, with values read as JSON when they parse (numbers, booleans, arrays,
 * objects) and as strings when they do not — so `limit=10` is a number and `project=web` a string,
 * which is what a person typing them means. `--args '{…}'` takes a whole object for anything
 * nested, and the two merge with `key=value` winning.
 */
export function toolArguments(pairs: readonly string[], json: string | undefined): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  if (json !== undefined && json !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      // The parser's own message is a position in a string the person cannot see the way the
      // shell delivered it. Naming the flag and the shape is what gets it fixed.
      throw new Error(
        `--args is not valid JSON (${error instanceof Error ? error.message : String(error)}). It takes one object, like --args '{"limit":10}'.`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--args must be a JSON object.');
    args = { ...(parsed as Record<string, unknown>) };
  }
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new Error(`Arguments are key=value; got "${pair}".`);
    const key = pair.slice(0, equals);
    const raw = pair.slice(equals + 1);
    try {
      args[key] = JSON.parse(raw);
    } catch {
      args[key] = raw;
    }
  }

  return args;
}

/**
 * Put the Vinktar block into an AGENTS.md: replace what is between its markers when they are
 * there, append the block when they are not, and leave every other byte of the file alone. The
 * file is the team's.
 */
export function upsertBlock(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_MD_BEGIN);
  const end = existing.indexOf(AGENTS_MD_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block.trim() + existing.slice(end + AGENTS_MD_END.length);
  }
  if (existing.trim() === '') return `${block.trim()}\n`;

  return `${existing.replace(/\s*$/, '')}\n\n${block.trim()}\n`;
}

function describe(tool: Tool): string {
  const kind = tool.annotations?.readOnlyHint === false ? 'write' : 'read';
  // The first sentence, ending at a full stop followed by a capital, so "e.g. a thing" stays whole.
  const summary = (tool.description ?? '').split(/(?<!\b[ei]\.[ge]\.)(?<=\.)\s+(?=[A-Z"`])/)[0] ?? '';

  return `${tool.name.padEnd(24)} ${kind.padEnd(6)} ${summary}`;
}

export async function runAgent(
  command: string,
  positional: readonly string[],
  flags: Map<string, string | boolean>,
  io: Io,
): Promise<number> {
  const url = mcpUrl(flags, io.env);
  const fetcher = bounded(io.fetcher ?? fetch, io.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const project = typeof flags.get('project') === 'string' ? (flags.get('project') as string) : undefined;
  const withProject = (args: Record<string, unknown>): Record<string, unknown> =>
    project === undefined ? args : { project, ...args };

  if (command === 'login') {
    const endpoints = await discover(url, fetcher);
    const remembered = await load(url, io.credentials);
    const clientId = remembered.clientId ?? (await register(endpoints, fetcher));
    await save(url, { ...remembered, clientId }, io.credentials);

    const { verifier, challenge } = pkce();
    const state = randomState();
    const callback = await listen(state, endpoints.issuer);
    const link = authorizeUrl(endpoints, { clientId, redirectUri: callback.redirectUri, challenge, state, resource: url });

    io.log('Opening Vinktar in your browser to sign in. If it does not open, visit:');
    io.log('');
    io.log(`  ${link}`);
    io.log('');
    io.log('Pick the workspace, optionally one project, and read or read and write.');
    if (flags.get('no-browser') !== true) (io.open ?? openBrowser)(link);

    const code = await callback.code;
    const session = await exchange(endpoints, { clientId, code, redirectUri: callback.redirectUri, verifier, resource: url }, fetcher);
    await save(url, { clientId, session }, io.credentials);
    io.log(`Signed in (${session.scope.includes('mcp:write') ? 'read and write' : 'read only'}).`);
    io.log('Next: vinktar status, or vinktar tools to see everything an agent can call.');

    return 0;
  }

  if (command === 'logout') {
    const remembered = await load(url, io.credentials);
    if (remembered.session === undefined) {
      io.log('Not signed in.');

      return 0;
    }
    const revoked = await revoke(remembered.session, fetcher);
    await save(url, { ...(remembered.clientId === undefined ? {} : { clientId: remembered.clientId }) }, io.credentials);
    io.log(revoked ? 'Signed out, and the connection revoked.' : 'Signed out here. Remove the connection on the AI agents page too.');

    return 0;
  }

  const shortcuts: Record<string, () => [string, Record<string, unknown>]> = {
    guide: () => ['get_install_guide', {}],
    keys: () => ['get_project_keys', withProject({})],
    status: () => ['get_setup_status', withProject({})],
    changes: () => {
      const last = flags.get('last');

      return ['whats_changed', withProject(typeof last === 'string' ? { last } : {})];
    },
    sql: () => {
      const query = positional[1];
      if (query === undefined) throw new Error('Give the query: vinktar sql "SELECT event_name, count() FROM events GROUP BY event_name"');

      return ['run_sql', withProject({ query })];
    },
    call: () => {
      const name = positional[1];
      if (name === undefined) throw new Error('Name the tool: vinktar call <tool> key=value … (vinktar tools lists them).');
      const json = flags.get('args');

      return [name, withProject(toolArguments(positional.slice(2), typeof json === 'string' ? json : undefined))];
    },
  };

  // Worked out before the sign-in is checked. `vinktar call` with no tool is wrong whoever runs it,
  // and answering "Not signed in" sends an agent to a browser over an argument it left out.
  const planned = shortcuts[command]?.();

  const client = await McpClient.signedIn(url, fetcher, io.credentials);

  if (command === 'tools') {
    const tools = await client.tools();
    if (flags.get('json') === true) {
      io.log(JSON.stringify(tools, null, 2));

      return 0;
    }
    for (const tool of tools) io.log(describe(tool));
    io.log('');
    io.log('Run one with: vinktar call <tool> key=value … (vinktar tools --json has every argument).');

    return 0;
  }

  if (command === 'agents-md') {
    const block = await client.resource(AGENTS_MD_URI);
    const target = flags.get('write');
    if (target === undefined) {
      io.log(block);

      return 0;
    }
    const path = typeof target === 'string' ? target : 'AGENTS.md';
    const existing = await readFile(path, 'utf8').catch(() => '');
    await writeFile(path, upsertBlock(existing, block));
    io.log(`${existing === '' ? 'Created' : 'Updated'} the Vinktar block in ${path}.`);

    return 0;
  }

  const [tool, args] = planned!;
  const result = await client.call(tool, args);
  (result.isError ? io.fail : io.log)(result.text);

  return result.isError ? 1 : 0;
}
