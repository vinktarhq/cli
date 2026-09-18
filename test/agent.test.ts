import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENTS_MD_BEGIN, AGENTS_MD_END, runAgent, toolArguments, upsertBlock } from '../src/commands/agent.js';
import { load, save } from '../src/agent/store.js';

/**
 * A stand-in for the server: discovery, registration, the token endpoint (codes and refreshes,
 * with rotation), revocation, and a stateless MCP endpoint. Enough to drive `login` from start to
 * finish — the test plays the browser by following the authorize link itself.
 */
class FakeServer {
  server!: Server;
  origin = '';
  registrations = 0;
  refreshes = 0;
  revoked: string[] = [];
  calls: { method: string; params: Record<string, unknown>; auth: string }[] = [];
  /** Access tokens the MCP endpoint accepts. */
  valid = new Set<string>();
  private codes = new Map<string, { challenge: string; redirect: string }>();
  private refreshTokens = new Set<string>();
  private seq = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get mcp(): string {
    return `${this.origin}/mcp`;
  }

  private issue(): { access_token: string; refresh_token: string; expires_in: number; scope: string } {
    const access = `at_${++this.seq}`;
    const refresh = `rt_${this.seq}`;
    this.valid.add(access);
    this.refreshTokens.add(refresh);

    return { access_token: access, refresh_token: refresh, expires_in: 3600, scope: 'mcp:read mcp:write' };
  }

  private async body(request: IncomingMessage): Promise<string> {
    let data = '';
    for await (const chunk of request) data += chunk;

    return data;
  }

  private async handle(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return send(200, { resource: this.mcp, authorization_servers: [this.origin] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/oauth/authorize`,
        token_endpoint: `${this.origin}/oauth/token`,
        registration_endpoint: `${this.origin}/oauth/register`,
        revocation_endpoint: `${this.origin}/oauth/revoke`,
      });
    }
    if (url.pathname === '/oauth/register') {
      this.registrations += 1;
      const doc = JSON.parse(await this.body(request)) as { redirect_uris: string[]; token_endpoint_auth_method: string };
      expect(doc.redirect_uris).toEqual(['http://127.0.0.1/callback']);
      expect(doc.token_endpoint_auth_method).toBe('none');

      return send(201, { client_id: 'vnk_client_test' });
    }
    if (url.pathname === '/oauth/authorize') {
      // The person approves: a code bound to the PKCE challenge and the redirect it came with.
      const code = `code_${++this.seq}`;
      const redirect = url.searchParams.get('redirect_uri')!;
      this.codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      back.searchParams.set('iss', this.origin);
      response.writeHead(302, { Location: back.toString() }).end();

      return;
    }
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(await this.body(request));
      if (form.get('grant_type') === 'authorization_code') {
        const issued = this.codes.get(form.get('code')!);
        const verifier = form.get('code_verifier')!;
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (issued === undefined || issued.challenge !== challenge || issued.redirect !== form.get('redirect_uri')) {
          return send(400, { error: 'invalid_grant' });
        }
        this.codes.delete(form.get('code')!);

        return send(200, this.issue());
      }
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token')!;
        if (!this.refreshTokens.delete(token)) return send(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        this.refreshes += 1;

        return send(200, this.issue());
      }

      return send(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/oauth/revoke') {
      this.revoked.push(new URLSearchParams(await this.body(request)).get('token')!);

      return send(200, {});
    }
    if (url.pathname === '/mcp') {
      const auth = request.headers.authorization ?? '';
      if (!this.valid.has(auth.replace('Bearer ', ''))) {
        response.writeHead(401).end();

        return;
      }
      const message = JSON.parse(await this.body(request)) as { id: number; method: string; params: Record<string, unknown> };
      this.calls.push({ method: message.method, params: message.params, auth });
      const result =
        message.method === 'tools/list'
          ? {
              tools: [
                { name: 'get_setup_status', description: 'What has arrived. More detail.', annotations: { readOnlyHint: true } },
                { name: 'query_funnel', description: 'Conversion through steps (e.g. Signed up to Paid). More.', annotations: { readOnlyHint: true } },
                { name: 'create_rule', description: 'Create an alert rule. It notifies owners.', annotations: { readOnlyHint: false } },
              ],
            }
          : message.method === 'resources/read'
            ? { contents: [{ text: `${AGENTS_MD_BEGIN}\n## Vinktar\n\nThe block.\n${AGENTS_MD_END}` }] }
            : message.params.name === 'broken'
              ? { content: [{ type: 'text', text: 'That did not work.' }], isError: true }
              : { content: [{ type: 'text', text: `ran ${String(message.params.name)} ${JSON.stringify(message.params.arguments)}` }] };

      return send(200, { jsonrpc: '2.0', id: message.id, result });
    }

    send(404, {});
  }
}

describe('agent commands', () => {
  let server: FakeServer;
  let dir: string;
  let credentials: string;
  let out: string[];
  let err: string[];

  const io = (extra: { open?: (url: string) => void } = {}) => ({
    log: (line: string) => out.push(line),
    fail: (line: string) => err.push(line),
    env: {},
    credentials,
    ...extra,
  });
  const run = (command: string, positional: string[] = [command], flags: [string, string | boolean][] = []) =>
    runAgent(command, positional, new Map([['mcp', server.mcp], ...flags]), io());

  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    dir = await mkdtemp(join(tmpdir(), 'vinktar-agent-'));
    credentials = join(dir, 'config', 'credentials.json');
    out = [];
    err = [];
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** Sign in, playing the browser: follow the authorize link, which redirects to the loopback. */
  async function login(): Promise<number> {
    return runAgent(
      'login',
      ['login'],
      new Map<string, string | boolean>([['mcp', server.mcp]]),
      io({ open: (link) => void fetch(link) }),
    );
  }

  it('signs in with PKCE and a loopback redirect, and stores the session privately', async () => {
    expect(await login()).toBe(0);

    const { session, clientId } = await load(server.mcp, credentials);
    expect(clientId).toBe('vnk_client_test');
    expect(session?.accessToken).toBe('at_2');
    expect(session?.refreshToken).toBe('rt_2');
    expect(out.join('\n')).toContain('Signed in (read and write)');
    // A refresh token is as good as a password to the workspace.
    expect((await stat(credentials)).mode & 0o777).toBe(0o600);
  });

  it('registers once and reuses the client on the next sign-in', async () => {
    await login();
    await login();

    expect(server.registrations).toBe(1);
  });

  it('lists the tools, marking the ones that write', async () => {
    await login();
    out = [];

    expect(await run('tools')).toBe(0);
    expect(out[0]).toMatch(/^get_setup_status\s+read\s+What has arrived\.$/);
    expect(out[1]).toMatch(/^query_funnel\s+read\s+Conversion through steps \(e\.g\. Signed up to Paid\)\.$/);
    expect(out[2]).toMatch(/^create_rule\s+write\s+Create an alert rule\.$/);
  });

  it('calls a tool with key=value arguments read as JSON where they parse', async () => {
    await login();
    out = [];

    expect(await run('call', ['call', 'query_trends', 'limit=10', 'compare=true', 'names=["a","b"]', 'last=7d'])).toBe(0);
    expect(server.calls.at(-1)?.params).toEqual({
      name: 'query_trends',
      arguments: { limit: 10, compare: true, names: ['a', 'b'], last: '7d' },
    });
  });

  it('adds --project to every shortcut', async () => {
    await login();

    await run('status', ['status'], [['project', 'web']]);
    expect(server.calls.at(-1)?.params).toEqual({ name: 'get_setup_status', arguments: { project: 'web' } });

    await run('sql', ['sql', 'SELECT 1'], [['project', 'web']]);
    expect(server.calls.at(-1)?.params).toEqual({ name: 'run_sql', arguments: { project: 'web', query: 'SELECT 1' } });
  });

  it('reports a tool error on stderr with a failing exit code', async () => {
    await login();

    expect(await run('call', ['call', 'broken'])).toBe(1);
    expect(err).toContain('That did not work.');
  });

  it('refreshes an expired session before calling, and keeps the rotated token', async () => {
    await login();
    const remembered = await load(server.mcp, credentials);
    await save(server.mcp, { ...remembered, session: { ...remembered.session!, expiresAt: Date.now() - 1 } }, credentials);

    expect(await run('status')).toBe(0);
    expect(server.refreshes).toBe(1);
    expect((await load(server.mcp, credentials)).session?.refreshToken).toBe('rt_3');
  });

  it('refreshes once on a 401 and retries, as when the token was revoked early', async () => {
    await login();
    server.valid.clear();

    expect(await run('status')).toBe(0);
    expect(server.refreshes).toBe(1);
  });

  it('says to sign in again when the refresh itself is refused', async () => {
    await login();
    server.valid.clear();
    const remembered = await load(server.mcp, credentials);
    await save(server.mcp, { ...remembered, session: { ...remembered.session!, refreshToken: 'rt_gone' } }, credentials);

    await expect(run('status')).rejects.toThrow(/vinktar login/);
  });

  it('refuses to run a tool when not signed in, and says how to sign in', async () => {
    await expect(run('status')).rejects.toThrow('Run: vinktar login');
  });

  it('signs out, revokes the refresh token, and keeps the registered client', async () => {
    await login();
    out = [];

    expect(await run('logout')).toBe(0);
    expect(server.revoked).toEqual(['rt_2']);
    const after = await load(server.mcp, credentials);
    expect(after.session).toBeUndefined();
    expect(after.clientId).toBe('vnk_client_test');
  });

  it('writes the AGENTS.md block and leaves the rest of the file alone', async () => {
    await login();
    const path = join(dir, 'AGENTS.md');
    await writeFile(path, '# Team rules\n\nUse tabs.\n');

    expect(await run('agents-md', ['agents-md'], [['write', path]])).toBe(0);
    expect(await run('agents-md', ['agents-md'], [['write', path]])).toBe(0);

    const written = await readFile(path, 'utf8');
    expect(written.startsWith('# Team rules\n\nUse tabs.\n\n')).toBe(true);
    expect(written.split(AGENTS_MD_BEGIN)).toHaveLength(2); // once, however often it runs
  });
});

describe('toolArguments', () => {
  it('merges --args with key=value, key=value winning', () => {
    expect(toolArguments(['limit=5'], '{"limit":1,"series":[{"aggregation":"total"}]}')).toEqual({
      limit: 5,
      series: [{ aggregation: 'total' }],
    });
  });

  it('refuses what is not key=value, and --args that is not an object', () => {
    expect(() => toolArguments(['oops'], undefined)).toThrow('key=value');
    expect(() => toolArguments([], '[1]')).toThrow('JSON object');
  });
});

describe('upsertBlock', () => {
  const block = `${AGENTS_MD_BEGIN}\nnew\n${AGENTS_MD_END}`;

  it('replaces only what is between the markers', () => {
    const before = `top\n${AGENTS_MD_BEGIN}\nold\n${AGENTS_MD_END}\nbottom\n`;
    expect(upsertBlock(before, block)).toBe(`top\n${AGENTS_MD_BEGIN}\nnew\n${AGENTS_MD_END}\nbottom\n`);
  });

  it('appends after a blank line when the markers are not there, and starts an empty file cleanly', () => {
    expect(upsertBlock('top\n\n\n', block)).toBe(`top\n\n${block}\n`);
    expect(upsertBlock('', block)).toBe(`${block}\n`);
  });
});
