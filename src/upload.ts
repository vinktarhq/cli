import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { deriveDebugId, existingDebugId, injectIntoMap, mapDebugId } from './debug-id.js';
import { isEmptyMap, type Artifact } from './discover.js';
import { backoffMs, RETRIABLE_STATUS, retriable, send as request, timeoutFor } from './http.js';
import {
  CONSERVATIVE_BATCH_BYTES,
  DEFAULT_HOST,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
  RECOMMENDED_BATCH_BYTES,
  REQUIRED_SCOPE,
} from './limits.js';
import { multipart, overheadFor, type Part } from './multipart.js';
import { toUrl } from './url.js';

/**
 * Uploads source maps to `POST /v1/sourcemaps`.
 *
 * `files[]`, `urls[]` and `debug_ids[]` are **positional parallel arrays**: the server pairs them
 * by index, so appending to one without the others silently mis-pairs every entry after it. They
 * are therefore built in one loop and never separately.
 */

export interface UploadOptions {
  readonly host: string;
  readonly key: string;
  readonly release: string;
  readonly dist?: string;
  readonly urlPrefix: string;
  /** Per request, before the size allowance. Default 30 s. */
  timeoutMs?: number;
  /** Requests in flight. Default 4, or whatever the server asks for. */
  concurrency?: number;
  /** Attempts per request, including the first. Default 3. */
  maxRetries?: number;
  /** Extra headers, for a gateway that wants one. Never allowed to displace the key. */
  headers?: Readonly<Record<string, string>>;
  /** Appended to the User-Agent, so an ingest log can tell a plugin from a CI script. */
  plugin?: string;
  /**
   * Rewrite `sources` in the uploaded copy. Default true — see {@link rewrite}.
   * The file on disk is never touched.
   */
  rewriteSources?: boolean;
  /** The build root, which absolute `sources` are made relative to. */
  root?: string;
  env?: Record<string, string | undefined>;
}

/** What this deployment will actually accept, as it reports it. */
export interface Limits {
  readonly maxFileBytes: number;
  readonly maxPartBytes: number;
  readonly maxRequestBytes: number;
  readonly recommendedBatchBytes: number;
  readonly concurrency: number;
  readonly compression: readonly string[];
}

export interface UploadEntry {
  readonly name: string;
  readonly url: string;
  readonly debugId: string;
  readonly bytes: number;
  /** Content hash of the exact body that would be uploaded. The server's dedupe key. */
  readonly sha256: string;
  /**
   * Content hash of the map FILE as it sits on disk, which is a different string: the uploaded
   * body carries the debug id and, when a line was inserted, a shifted `mappings`.
   *
   * Only the plugins use it, and only to answer one question before deleting a map: are these
   * still the bytes that were uploaded? Turbopack rewrites files while later stages run, and a
   * map deleted there is one the server never received.
   */
  readonly mapSha256: string;
  /**
   * Whether the chunk itself carries the id. When false the id was derived here for the map only,
   * and no frame will ever report it: the map can then match by release + url alone.
   */
  readonly injected: boolean;
}

export interface UploadResult {
  readonly stored: number;
  readonly artifacts: ReadonlyArray<{ file_url?: string; debug_id?: string; size?: number }>;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Index one artifact: what it is, what it hashes to, and how big it will be on the wire.
 *
 * The body is built and then DISCARDED. Holding it would mean the whole build sitting in memory
 * before the first request left — a few hundred chunks of a real application is hundreds of
 * megabytes — and it is cheap to rebuild from a local file at the moment it is actually sent.
 *
 * Returns null when there is nothing to upload, rather than throwing: a directory of chunks where
 * only some have maps is normal, not an error.
 */
export async function index(
  artifact: Artifact,
  urlPrefix: string,
  options: Pick<UploadOptions, 'rewriteSources' | 'root'> = {},
): Promise<{ entry: UploadEntry; oversized: boolean; empty: boolean } | null> {
  if (artifact.map === null) return null;

  const { body, injected, raw } = await build(artifact, options);
  const bytes = Buffer.byteLength(body);

  return {
    entry: {
      name: basename(artifact.map),
      url: toUrl(urlPrefix, artifact.relative),
      debugId: debugIdOf(body),
      bytes,
      sha256: createHash('sha256').update(body).digest('hex'),
      mapSha256: createHash('sha256').update(raw).digest('hex'),
      injected,
    },
    // Reported, not thrown. One 20 MB chunk used to abort the whole upload, so a single
    // pathological bundle cost symbolication for every other file in the build.
    oversized: bytes > MAX_FILE_BYTES,
    // A map with no mappings and no sources answers no question; Vite emits one per HTML entry.
    empty: isEmptyMap(raw),
  };
}

/**
 * The exact bytes that go on the wire for this artifact.
 *
 * Deterministic, which is what lets `index` throw the body away and this rebuild it later: the id
 * already injected into the chunk wins, so a second call cannot produce a different map than the
 * one that was hashed.
 */
export async function materialise(
  artifact: Artifact,
  options: Pick<UploadOptions, 'rewriteSources' | 'root'> = {},
): Promise<string> {
  return (await build(artifact, options)).body;
}

async function build(
  artifact: Artifact,
  options: Pick<UploadOptions, 'rewriteSources' | 'root'>,
): Promise<{ body: string; injected: boolean; raw: string }> {
  if (artifact.map === null) throw new Error(`${artifact.relative} has no source map`);

  const [code, rawMap] = await Promise.all([
    readFile(artifact.file, 'utf8'),
    readFile(artifact.map, 'utf8'),
  ]);

  // Prefer the id already injected into the chunk: that is the one the SDK will report, and
  // deriving a fresh one here would produce a map nothing ever asks for. The map's own id is the
  // next best thing — a bundler that stamps ids natively writes it there and nowhere else.
  const injected = existingDebugId(code);
  const debugId = injected ?? mapDebugId(rawMap) ?? deriveDebugId(code);
  const prepared = options.rewriteSources === false ? rawMap : rewrite(rawMap, options.root);

  return { body: injectIntoMap(prepared, debugId), injected: injected !== null, raw: rawMap };
}

const SCHEME = /^(?:webpack|rollup|vite|ng|rspack|turbopack|file):\/{0,3}/i;

/**
 * Tidy `sources` in the uploaded copy, never on disk.
 *
 * Two things come out of a bundler that should not reach a server. `webpack:///./src/App.tsx` is
 * a protocol nothing can open, and it is what the UI would print beside every frame. And an
 * absolute path is the build machine's directory layout — `/home/runner/work/acme/acme/src/…`, or
 * worse, someone's home directory — which is both noise and information the ingest never asked
 * for.
 *
 * The uploaded copy only. Rewriting the file would change bytes another tool may already have
 * hashed, and the map on disk is the one a developer opens locally, where an absolute path is
 * exactly what they want.
 */
export function rewrite(mapJson: string, root?: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(mapJson);
  } catch {
    return mapJson;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return mapJson;

  const map = parsed as Record<string, unknown>;
  const sources = map['sources'];
  if (!Array.isArray(sources)) return mapJson;

  return JSON.stringify({
    ...map,
    sources: sources.map((source: unknown) => {
      if (typeof source !== 'string') return source;

      let value = source.replace(SCHEME, '');
      if (root !== undefined && root !== '' && isAbsolute(value)) {
        const inside = relative(root, value);
        // Only when it is genuinely inside the root: `../../../home/other` is not a tidier path,
        // it is the same path spelled less clearly.
        if (!inside.startsWith('..') && !isAbsolute(inside)) value = inside;
      }

      return value.split(sep).join('/').replace(/^\.\//, '');
    }),
  });
}

function debugIdOf(body: string): string {
  const parsed: unknown = JSON.parse(body);

  return typeof parsed === 'object' && parsed !== null
    ? String((parsed as Record<string, unknown>)['debugId'] ?? '')
    : '';
}

export interface Preflight {
  /** sha256 of the bodies the server already holds. */
  readonly stored: Set<string>;
  /** What this deployment accepts, when it says. Null on an older ingest, or an unreachable one. */
  readonly limits: Limits | null;
}

/**
 * Ask the server which of these bodies it already holds, and what it will accept.
 *
 * The dedupe half is purely an optimisation, so every failure mode answers "none": an older ingest
 * with no such route, a proxy in the way, a network blip. Uploading something the server already
 * has is a wasted request; NOT uploading something it does not have is a build with no
 * symbolication, and those are not the same mistake.
 *
 * The limits half matters more than it looks. The protocol says 20 MiB per file and 60 MiB per
 * request, but what a deployment actually accepts is the smaller of that and its PHP
 * `upload_max_filesize` / `post_max_size` — and a POST over `post_max_size` is not rejected, the
 * body is silently dropped and the server answers `missing_release`, which reads like a CLI bug.
 * Asking is the difference between a clear message and an afternoon.
 */
export async function preflight(options: UploadOptions, hashes: readonly string[]): Promise<Preflight> {
  try {
    const reply = await request({
      method: 'POST',
      url: `${options.host}/v1/sourcemaps/check`,
      key: options.key,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify({ sha256: hashes }),
      timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    if (reply.status < 200 || reply.status >= 300) return { stored: new Set(), limits: null };

    const payload = JSON.parse(reply.text) as Record<string, unknown>;
    const stored = payload['stored'];

    return {
      stored: Array.isArray(stored) ? new Set(stored.filter((v): v is string => typeof v === 'string')) : new Set(),
      limits: readLimits(payload['limits']),
    };
  } catch {
    return { stored: new Set(), limits: null };
  }
}

/**
 * Read the server's limits defensively.
 *
 * Every field falls back to the compiled-in protocol value, so a deployment that publishes half
 * the object, or an older one that publishes none of it, still gets a working client rather than
 * a batch sized `NaN`.
 */
function readLimits(value: unknown): Limits | null {
  if (typeof value !== 'object' || value === null) return null;

  const raw = value as Record<string, unknown>;
  const number = (name: string, fallback: number): number => {
    const found = raw[name];

    return typeof found === 'number' && Number.isFinite(found) && found > 0 ? found : fallback;
  };

  const maxFileBytes = number('maxFileBytes', MAX_FILE_BYTES);

  return {
    maxFileBytes,
    // `maxPartBytes` is the ini-aware one: the same deployment can advertise a 20 MiB protocol
    // ceiling and a 2 MiB `upload_max_filesize`, and only one of those is true of the socket.
    maxPartBytes: number('maxPartBytes', maxFileBytes),
    maxRequestBytes: number('maxRequestBytes', MAX_REQUEST_BYTES),
    // The server calls it `maxBatchBytes`; the older draft of the protocol called it
    // `recommendedBatchBytes`, and both spellings are read so the deploy order of the two halves
    // is not load-bearing.
    recommendedBatchBytes: number('maxBatchBytes', number('recommendedBatchBytes', RECOMMENDED_BATCH_BYTES)),
    concurrency: number('concurrency', DEFAULT_CONCURRENCY),
    compression: Array.isArray(raw['compression'])
      ? raw['compression'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/** Four at a time: enough to hide the latency, few enough not to trip the ingest rate limit. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Send one batch.
 *
 * Batches are bounded by the request ceiling rather than by count: maps vary from kilobytes to
 * megabytes, so a fixed count would either waste requests or overshoot.
 *
 * Each part is gzipped when the server says it accepts that. `Content-Encoding` does NOT survive
 * multipart parsing — PHP hands the handler the raw part and nothing else — so a compressed part
 * is simply a part whose bytes are gzip, which the server detects by its magic number. Source maps
 * are JSON with long runs of repeated source text and compress by 80–90%, which is the difference
 * between one request and six.
 */
export async function send(
  options: UploadOptions,
  batch: ReadonlyArray<{ entry: UploadEntry; body: string }>,
  limits: Limits | null = null,
): Promise<UploadResult> {
  const compress = limits?.compression.includes('gzip') === true;

  const parts: Part[] = [
    { name: 'release', value: options.release },
    ...(options.dist === undefined || options.dist === '' ? [] : [{ name: 'dist', value: options.dist }]),
  ];

  for (const { entry, body } of batch) {
    parts.push({
      name: 'files[]',
      value: compress ? gzipSync(Buffer.from(body, 'utf8'), { level: 6 }) : body,
      filename: entry.name,
      contentType: 'application/json',
    });
    parts.push({ name: 'urls[]', value: entry.url });
    parts.push({ name: 'debug_ids[]', value: entry.debugId });
  }

  const { body, contentType } = multipart(parts);
  const attempts = Math.max(1, options.maxRetries ?? MAX_ATTEMPTS);
  const isDefaultHost = options.host === DEFAULT_HOST;

  // Bounded and retried. A deploy step that hangs on a half-open socket, or fails its whole run
  // on one 502 from a proxy in front of ingest, is worse than a build without symbolication;
  // the response table says these are transient, so they get the protocol's retry, with backoff.
  for (let attempt = 0; ; attempt += 1) {
    let reply: Awaited<ReturnType<typeof request>>;
    try {
      reply = await request({
        method: 'POST',
        url: `${options.host}/v1/sourcemaps`,
        key: options.key,
        headers: { 'Content-Type': contentType, ...options.headers },
        body,
        timeoutMs: timeoutFor(body.length, options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      if (attempt < attempts - 1 && retriable(error, isDefaultHost)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new UploadError(
        `Could not reach ${options.host}${attempt > 0 ? ` after ${attempt + 1} attempts` : ''}: ${error instanceof Error ? error.message : String(error)}`,
        0,
        'network',
        'Check the host and that the machine running this can reach it.',
      );
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(reply.text) as Record<string, unknown>;
    } catch {
      // A non-JSON body means something in front of the app answered — a proxy, a WAF, a 502 page.
    }

    if (reply.status === 201) {
      return {
        stored: Number(payload['stored'] ?? batch.length),
        artifacts: Array.isArray(payload['artifacts']) ? payload['artifacts'] : [],
      };
    }

    if (RETRIABLE_STATUS.has(reply.status) && attempt < attempts - 1) {
      await sleep(backoffMs(attempt, reply.header('retry-after')));
      continue;
    }

    throw describe(reply.status, payload, reply.text);
  }
}

/** Three tries: one for the blip, one for the restart, then the truth. */
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn a rejection into something actionable.
 *
 * Every one of these is a mistake someone will make, and the raw code alone tells them nothing.
 * `cli_scope_required` in particular looks like a bad key when it is really the right key with the
 * wrong scope, and without the hint that is a long afternoon.
 */
function describe(status: number, payload: Record<string, unknown>, raw: string): UploadError {
  const code = String(payload['error'] ?? payload['message'] ?? '') || `http_${status}`;

  switch (code) {
    case 'cli_scope_required':
      return new UploadError(
        'That key cannot upload source maps.',
        status,
        code,
        `Source-map upload needs a key with the "${REQUIRED_SCOPE}" scope. A write key is not enough — create one in project settings.`,
      );

    case 'missing_api_key':
    case 'invalid_api_key':
      return new UploadError(
        'The write key was rejected.',
        status,
        code,
        'Check --key, or the VINKTAR_CLI_KEY environment variable.',
      );

    case 'missing_release':
      return new UploadError(
        'A release is required.',
        status,
        code,
        // The second sentence is the one that saves the afternoon: an oversized POST is not
        // rejected by PHP, the body is dropped, and the server then honestly reports no release.
        'Pass --release with the same value your SDK reports. If you did pass one, the request was over the server\'s post_max_size and its body was discarded before PHP saw it — lower the batch size or raise post_max_size.',
      );

    case 'invalid_release':
    case 'invalid_dist':
      return new UploadError(
        `The ${code === 'invalid_release' ? 'release' : 'dist'} name was rejected.`,
        status,
        code,
        'It must be at most 64 bytes and contain no slashes, control characters, or leading or trailing whitespace.',
      );

    case 'missing_url_or_debug_id':
      return new UploadError(
        'A file had neither a URL nor a debug id, so the whole upload was rejected.',
        status,
        code,
        'This is a bug in the CLI — please report it with the command you ran.',
      );

    case 'quota_exceeded': {
      const quota = Number(payload['quota_bytes'] ?? 0);
      const used = Number(payload['used_bytes'] ?? 0);

      return new UploadError(
        `Source-map storage is full: ${mb(used)} of ${mb(quota)} used.`,
        status,
        code,
        'Delete old releases from project settings, or upgrade the plan for more storage.',
      );
    }

    case 'file_too_large':
      return new UploadError(
        `A map is over the ${mb(Number(payload['max_bytes'] ?? MAX_FILE_BYTES))} per-file limit.`,
        status,
        code,
        'Split the bundle, or exclude that chunk with --ignore.',
      );

    case 'payload_too_large':
      return new UploadError(
        `The request was too large${payload['max_bytes'] === undefined ? '' : ` (the server accepts ${mb(Number(payload['max_bytes']))})`}.`,
        status,
        code,
        'Lower --concurrency, or raise the server\'s post_max_size.',
      );

    default:
      return new UploadError(
        `Ingest rejected the upload (HTTP ${status}).`,
        status,
        code,
        raw.slice(0, 200) || undefined,
      );
  }
}

/**
 * Group indexed maps into requests that fit.
 *
 * The budget is approached with headroom, because multipart framing and the field names add bytes
 * the file sizes do not account for, and an oversized request costs the whole batch. Sized on the
 * UNCOMPRESSED bodies even when the parts will be gzipped: compression only ever makes the request
 * smaller, so the bound stays true and one batch's worth of maps is still what sits in memory.
 *
 * Generic over whatever the caller is carrying alongside the entry, so a batch can hold the
 * artifact each map came from and the body can be read back from disk as its batch is sent —
 * nothing here pins the build in memory.
 */
export function batch<T extends { readonly entry: UploadEntry }>(
  items: readonly T[],
  limits: Limits | null = null,
): T[][] {
  // Without a word from the server this stays deliberately small — see CONSERVATIVE_BATCH_BYTES.
  const budget =
    limits === null
      ? CONSERVATIVE_BATCH_BYTES
      : Math.max(1, Math.min(limits.recommendedBatchBytes, Math.floor(limits.maxRequestBytes * 0.9)));
  const framing = overheadFor({ name: 'files[]', value: '', filename: 'x'.repeat(64), contentType: 'application/json' });

  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;

  for (const item of items) {
    const cost = item.entry.bytes + framing;
    if (current.length > 0 && size + cost > budget) {
      batches.push(current);
      current = [];
      size = 0;
    }

    current.push(item);
    size += cost;
  }

  if (current.length > 0) batches.push(current);

  return batches;
}

/**
 * Run `work` over `items` with a bounded number in flight.
 *
 * Source maps are large and the server is usually far away, so a build of two hundred chunks spent
 * most of its upload waiting on a socket. Bounded rather than unbounded: an unbounded fan-out of
 * 6 MB requests is how a deploy step gets itself rate-limited.
 */
export async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await work(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));

  return results;
}

export function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
