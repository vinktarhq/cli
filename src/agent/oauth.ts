import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bounded, NetworkError } from './net.js';
import type { Session } from './store.js';

/**
 * Signing in to the Vinktar MCP server from a terminal: OAuth 2.1 with PKCE and a loopback
 * redirect (RFC 8252), discovered from the server rather than hard-coded, with the client
 * registered dynamically the first time and reused after.
 *
 * The same flow an editor runs when it connects, on purpose. The point of the CLI's agent commands
 * is to give a harness with no MCP support the same connection one with support would have — the
 * same consent screen, the same workspace and project the person picks there, the same limits and
 * the same call log. A second kind of credential would be a second thing to reason about.
 */

export const SCOPES = 'mcp:read mcp:write';

export interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly registration: string | null;
  readonly revocation: string | null;
  readonly issuer: string;
}

export class OAuthError extends Error {}

type Fetch = typeof fetch;

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Reported below with the status; a gateway error page is not worth quoting.
  }
  if (!response.ok) {
    const error = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const detail = typeof error.error_description === 'string' ? error.error_description : String(error.error ?? '');
    throw new OAuthError(`${what} failed (${response.status})${detail === '' ? '' : `: ${detail}`}`);
  }
  if (body === null || typeof body !== 'object') throw new OAuthError(`${what} did not return JSON.`);

  return body as Record<string, unknown>;
}

/** The server's endpoints, from the resource metadata and then the authorization server's. */
export async function discover(mcpUrl: string, fetcher: Fetch = bounded()): Promise<Endpoints> {
  const url = new URL(mcpUrl);
  let issuer = url.origin;

  // RFC 9728: the resource says which authorization server guards it. A server that predates it
  // is its own authorization server, which is the fallback. That is a server answering 404, not a
  // server that cannot be reached: asking the same host a second question would only be a second
  // wait for the same failure.
  const resource = await fetcher(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`).catch(
    (error: unknown) => {
      if (error instanceof NetworkError) throw error;

      return null;
    },
  );
  if (resource?.ok) {
    const body = (await resource.json().catch(() => ({}))) as { authorization_servers?: unknown };
    const first = Array.isArray(body.authorization_servers) ? body.authorization_servers[0] : undefined;
    if (typeof first === 'string') issuer = first.replace(/\/$/, '');
  }

  const meta = await json(await fetcher(`${issuer}/.well-known/oauth-authorization-server`), 'Discovery');
  const str = (key: string): string | null => (typeof meta[key] === 'string' ? (meta[key] as string) : null);
  const authorization = str('authorization_endpoint');
  const token = str('token_endpoint');
  if (authorization === null || token === null) throw new OAuthError('The server does not advertise an authorization or token endpoint.');

  return {
    authorization,
    token,
    registration: str('registration_endpoint'),
    revocation: str('revocation_endpoint'),
    issuer: str('issuer') ?? issuer,
  };
}

/**
 * A loopback redirect: registered without a port, presented with whichever one the OS gave us.
 * RFC 8252 §7.3 lets a loopback redirect differ from the registered one only in its port, which is
 * what makes one registration reusable across runs.
 */
export const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';

export async function register(endpoints: Endpoints, fetcher: Fetch = bounded()): Promise<string> {
  if (endpoints.registration === null) throw new OAuthError('The server does not allow clients to register themselves.');

  const body = await json(
    await fetcher(endpoints.registration, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Vinktar CLI',
        client_uri: 'https://github.com/vinktarhq/cli',
        redirect_uris: [REGISTERED_REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }),
    'Registering the CLI',
  );
  if (typeof body.client_id !== 'string') throw new OAuthError('Registration returned no client_id.');

  return body.client_id;
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface Callback {
  readonly redirectUri: string;
  /** Resolves with the code once the browser comes back; rejects on an error, a bad state or timeout. */
  readonly code: Promise<string>;
  readonly close: () => void;
}

const PAGE = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;background:#141312;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div><h1 style="font-size:20px">${title}</h1><p style="color:#aaa">${line}</p></div>`;

/** A one-shot HTTP server on 127.0.0.1 that waits for the authorization redirect. */
export async function listen(state: string, issuer: string, timeoutMs = 5 * 60_000): Promise<Callback> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }

    const fail = (message: string): void => {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in did not finish', message));
      settle?.reject(new OAuthError(message));
    };

    const error = url.searchParams.get('error');
    if (error !== null) return fail(url.searchParams.get('error_description') ?? error);
    // A redirect with someone else's state is not ours to accept, however it got here.
    if (url.searchParams.get('state') !== state) return fail('The response did not match this sign-in. Run vinktar login again.');
    // RFC 9207: when the server names itself, it must be the one we asked.
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) return fail('The response came from a different server.');

    const received = url.searchParams.get('code');
    if (received === null || received === '') return fail('The response carried no authorization code.');

    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(PAGE('Signed in to Vinktar', 'You can close this tab and go back to the terminal.'));
    settle?.resolve(received);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle?.reject(new OAuthError('Sign-in timed out after five minutes.')), timeoutMs);
  timer.unref();

  const close = (): void => {
    clearTimeout(timer);
    server.close();
  };
  code.then(close, close);

  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}

export function authorizeUrl(
  endpoints: Endpoints,
  params: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scope?: string },
): string {
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    scope: params.scope ?? SCOPES,
    resource: params.resource,
  }).toString();

  return url.toString();
}

function toSession(body: Record<string, unknown>, clientId: string, endpoints: Endpoints, previousRefresh: string | null): Session {
  if (typeof body.access_token !== 'string') throw new OAuthError('The token response carried no access token.');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;

  return {
    clientId,
    accessToken: body.access_token,
    // Refresh tokens rotate: a response without one keeps the old one, which is the server saying
    // it did not rotate this time.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previousRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenEndpoint: endpoints.token,
    revocationEndpoint: endpoints.revocation,
    scope: typeof body.scope === 'string' ? body.scope : SCOPES,
  };
}

export async function exchange(
  endpoints: Endpoints,
  params: { clientId: string; code: string; redirectUri: string; verifier: string; resource: string },
  fetcher: Fetch = bounded(),
): Promise<Session> {
  const body = await json(
    await fetcher(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: params.clientId,
        code_verifier: params.verifier,
        resource: params.resource,
      }).toString(),
    }),
    'Exchanging the code',
  );

  return toSession(body, params.clientId, endpoints, null);
}

export async function refresh(session: Session, resource: string, fetcher: Fetch = bounded()): Promise<Session> {
  if (session.refreshToken === null) throw new OAuthError('The session has expired. Run vinktar login.');

  const body = await json(
    await fetcher(session.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId,
        resource,
      }).toString(),
    }),
    'Refreshing the session',
  ).catch((error: unknown) => {
    throw new OAuthError(
      `${error instanceof Error ? error.message : String(error)}. The connection may have been revoked on the AI agents page; run vinktar login.`,
    );
  });

  return toSession(
    body,
    session.clientId,
    { authorization: '', token: session.tokenEndpoint, registration: null, revocation: session.revocationEndpoint, issuer: '' },
    session.refreshToken,
  );
}

/** Best effort: signing out locally must work even when the server cannot be reached. */
export async function revoke(session: Session, fetcher: Fetch = bounded()): Promise<boolean> {
  if (session.revocationEndpoint === null) return false;
  const token = session.refreshToken ?? session.accessToken;
  const response = await fetcher(session.revocationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: session.clientId }).toString(),
  }).catch(() => null);

  return response?.ok ?? false;
}

export function randomState(): string {
  return randomBytes(16).toString('base64url');
}
