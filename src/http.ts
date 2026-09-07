import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';

import { VERSION } from './version.js';

/**
 * The one place a request leaves this package.
 *
 * `fetch` does the work, except when it cannot: Node's `fetch` ignores `HTTPS_PROXY` entirely, and
 * in a corporate network that is not a slow upload but an `ECONNREFUSED` from a CLI that "works on
 * my machine" while every other tool in the pipeline succeeds. When a proxy is configured the
 * request goes out over `node:http`/`node:https` through a CONNECT tunnel instead; when one is
 * not — the overwhelmingly common case — nothing about the path changes.
 */

export interface RequestOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly key?: string;
  readonly body?: Buffer | string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Whole-request deadline. Callers scale it for large bodies. */
  readonly timeoutMs: number;
  /** Appended to the User-Agent, e.g. `vite-plugin/0.1.0`. */
  readonly plugin?: string;
  readonly env?: Record<string, string | undefined>;
}

export interface Reply {
  readonly status: number;
  readonly text: string;
  header(name: string): string | null;
}

/**
 * `vinktar-cli/<version> (node/<version>)`, plus the plugin when a bundler is driving.
 *
 * The server logs it, and "which of these is the Vite plugin and which is a hand-run CI script" is
 * the first question anyone asks of an ingest log.
 */
export function userAgent(plugin?: string): string {
  const base = `vinktar-cli/${VERSION} (node/${process.versions.node})`;

  return plugin === undefined || plugin === '' ? base : `${base} ${plugin}`;
}

export async function send(options: RequestOptions): Promise<Reply> {
  const headers: Record<string, string> = {
    'User-Agent': userAgent(options.plugin),
    ...(options.key === undefined || options.key === '' ? {} : { 'X-Vinktar-Key': options.key }),
    ...options.headers,
  };

  const proxy = proxyFor(options.url, options.env ?? process.env);
  if (proxy !== null) return throughProxy(proxy, options, headers);

  const response = await fetch(options.url, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const text = await response.text();

  return { status: response.status, text, header: (name) => response.headers.get(name) };
}

/**
 * The proxy that should carry a request to `url`, honouring `NO_PROXY`.
 *
 * Lower case wins over upper case, which is what curl does and therefore what people expect:
 * `http_proxy` is the historical spelling and the one a shell profile sets.
 */
export function proxyFor(url: string, env: Record<string, string | undefined> = process.env): URL | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }

  if (bypassed(target.hostname, env['no_proxy'] ?? env['NO_PROXY'] ?? '')) return null;

  const names = target.protocol === 'https:' ? (['https_proxy', 'HTTPS_PROXY'] as const) : (['http_proxy', 'HTTP_PROXY'] as const);
  const value = env[names[0]] ?? env[names[1]] ?? '';
  if (value.trim() === '') return null;

  try {
    return new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    return null;
  }
}

function bypassed(hostname: string, list: string): boolean {
  if (list.trim() === '*') return true;

  const host = hostname.toLowerCase();

  return list
    .split(',')
    .map((entry) => entry.trim().replace(/^\./, '').toLowerCase())
    .filter((entry) => entry !== '')
    .some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Send through a proxy.
 *
 * An https target needs a CONNECT tunnel, because the proxy must not be able to read the key or
 * the source it is carrying. A plain http target is an absolute-URI request, which is the older
 * and simpler form the same proxies still speak.
 */
async function throughProxy(
  proxy: URL,
  options: RequestOptions,
  headers: Record<string, string>,
): Promise<Reply> {
  const target = new URL(options.url);
  const secure = target.protocol === 'https:';
  const socket = secure ? await tunnel(proxy, target, options.timeoutMs) : null;

  return new Promise<Reply>((resolve, reject) => {
    const perform = secure ? httpsRequest : httpRequest;
    const request = perform(
      secure
        ? {
            method: options.method,
            host: target.hostname,
            port: target.port === '' ? 443 : Number(target.port),
            path: `${target.pathname}${target.search}`,
            headers,
            createConnection: () => socket!,
            timeout: options.timeoutMs,
          }
        : {
            method: options.method,
            host: proxy.hostname,
            port: proxy.port === '' ? 80 : Number(proxy.port),
            // Absolute URI: the proxy needs to know where this is going, since there is no tunnel.
            path: options.url,
            headers: { ...headers, Host: target.host, ...proxyAuth(proxy) },
            timeout: options.timeoutMs,
          },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            header: (name) => {
              const value = response.headers[name.toLowerCase()];

              return typeof value === 'string' ? value : null;
            },
          }),
        );
      },
    );

    request.on('timeout', () => request.destroy(new Error(`timed out after ${options.timeoutMs} ms`)));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function proxyAuth(proxy: URL): Record<string, string> {
  if (proxy.username === '') return {};

  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;

  return { 'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };
}

/** Open a CONNECT tunnel to the target, over which TLS is then negotiated end to end. */
async function tunnel(proxy: URL, target: URL, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const port = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port);
    const host = `${target.hostname}:${target.port === '' ? 443 : target.port}`;
    const auth = proxyAuth(proxy)['Proxy-Authorization'];

    const client = connect({ host: proxy.hostname, port }, () => {
      client.write(
        `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n` +
          (auth === undefined ? '' : `Proxy-Authorization: ${auth}\r\n`) +
          '\r\n',
      );
    });

    client.setTimeout(timeoutMs, () => {
      client.destroy();
      reject(new Error(`the proxy at ${proxy.host} did not answer within ${timeoutMs} ms`));
    });
    client.once('error', reject);
    client.once('data', (chunk: Buffer) => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString('latin1'))?.[1] ?? 0);
      if (status === 200) {
        client.setTimeout(0);
        resolve(client);

        return;
      }
      client.destroy();
      reject(
        new Error(`the proxy at ${proxy.host} refused a tunnel to ${target.host} (HTTP ${status === 0 ? 'unknown' : status})`),
      );
    });
  });
}

/** Exposed so the retry policy can be asserted rather than inferred from a stack trace. */
export const RETRIABLE_STATUS = new Set([429, 502, 503, 504, 507, 524]);

const RETRIABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Whether a failed request is worth repeating.
 *
 * `ENOTFOUND` is on the list only for the default host: a self-hosted URL that does not resolve is
 * a typo, and retrying a typo three times with backoff turns a one-second error into a ten-second
 * one and teaches nobody anything.
 */
export function retriable(error: unknown, isDefaultHost: boolean): boolean {
  const code =
    (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return isDefaultHost;
  if (RETRIABLE_CODES.has(code)) return true;

  return error instanceof Error && /terminated|fetch failed|timed out|socket hang up/i.test(error.message);
}

/**
 * How long to wait before trying again.
 *
 * `Retry-After` is honoured when the server sends one — it is the only party that knows when its
 * rate limit resets — and capped, because a proxy answering `Retry-After: 3600` must not hang a
 * deploy for an hour. Otherwise exponential with jitter, so two builds that fail together do not
 * retry together.
 */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const header = Number(retryAfter ?? 0);
  if (Number.isFinite(header) && header > 0) return Math.min(60_000, header * 1000);

  return Math.min(10_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/**
 * The deadline for a request carrying `bytes`.
 *
 * One flat timeout punishes a large upload for being large: 30 s is generous for a handshake and
 * mean for 40 MB over a hotel connection. This is the connect-and-settle allowance plus an
 * assumption of a slow-but-real 1 Mbit/s.
 */
export function timeoutFor(bytes: number, base: number): number {
  return base + Math.ceil(bytes / 131_072) * 1000;
}
