import { DEFAULT_HOST, MAX_NAME_BYTES } from './limits.js';

/**
 * One place that decides what every setting is, and one place that refuses a bad one.
 *
 * ## Precedence
 *
 * flag → environment → `.env` file → compiled-in default, highest first, with the server's
 * published limits filling in the sizes further down the line. It reads in that order for the
 * reason every tool does: the thing you typed last should win, and a file checked into a repo must
 * never quietly outrank a secret the CI supplied.
 *
 * ## Why blank is an error and not a default
 *
 * Every value is trimmed, and a value that is blank AFTER trimming is refused BY NAME rather than
 * silently falling through to the next source. `VINKTAR_CLI_KEY=$(echo "$KEY")` leaves a trailing
 * newline; `--release ""` from a shell variable that was never set leaves an empty string. Both
 * used to be indistinguishable from "not set", so the CLI carried on and uploaded the whole build
 * under the release named "".
 */

export interface Sources {
  readonly flags: ReadonlyMap<string, string | boolean>;
  /** Values of repeatable flags, in the order they were given. */
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly env: Record<string, string | undefined>;
  /** Values read from a `.env` file, which rank BELOW the process environment. */
  readonly dotenv?: Record<string, string>;
}

export interface Resolved {
  readonly host: string;
  readonly key: string;
  readonly release: string;
  readonly dist: string;
  readonly urlPrefix: string;
  readonly concurrency: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly maxRetries: number | undefined;
  readonly headers: Record<string, string>;
  readonly ignore: string[];
  readonly extensions: string[] | undefined;
  readonly rewriteSources: boolean;
  readonly quiet: boolean;
  readonly debug: boolean;
  readonly strict: boolean;
  readonly allowFailure: boolean;
  readonly dryRun: boolean;
  readonly inject: boolean;
  /** Fatal problems, phrased for someone who is about to fix one. */
  readonly errors: string[];
  /** Worth saying, not worth stopping for. */
  readonly warnings: string[];
}

/** Characters a name may not contain: the control range, plus DEL. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');

export function resolve(sources: Sources): Resolved {
  const errors: string[] = [];
  const warnings: string[] = [];

  const text = (flag: string, ...names: string[]): string => {
    const value = sources.flags.get(flag);
    if (typeof value === 'string') return check(value, `--${flag}`, errors);

    for (const name of names) {
      const found = sources.env[name] ?? sources.dotenv?.[name];
      if (found !== undefined && found !== '') return check(found, `$${name}`, errors);
    }

    return '';
  };

  const switched = (name: string, ...envNames: string[]): boolean => {
    if (sources.flags.get(name) === true) return true;
    if (sources.flags.get(`no-${name}`) === true) return false;

    return envNames.some((envName) => truthy(sources.env[envName] ?? sources.dotenv?.[envName]));
  };

  const host = (text('host', 'VINKTAR_HOST') || DEFAULT_HOST).replace(/\/+$/, '');
  try {
    const parsed = new URL(host);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push(`The host must be http or https, not "${parsed.protocol.replace(':', '')}".`);
    }
  } catch {
    errors.push(`"${host}" is not a URL. Pass --host like https://in.vinktar.com.`);
  }

  /**
   * `VINKTAR_CLI_KEY` first: source-map upload needs the `cli` scope, and a CI that already
   * exports `VINKTAR_KEY` for the browser bundle is exporting a PUBLIC write key — which this
   * endpoint refuses with `cli_scope_required`, a message that reads like a bad key rather than
   * the right key with the wrong scope.
   */
  const key = text('key', 'VINKTAR_CLI_KEY', 'VINKTAR_KEY');
  if (key.startsWith('vnk_pk_')) {
    warnings.push(
      'That looks like a public write key. Source-map upload needs the "cli" scope; set $VINKTAR_CLI_KEY to a key that has it.',
    );
  }

  const release = text('release', 'VINKTAR_RELEASE');
  nameable(release, 'release', errors);

  const dist = text('dist', 'VINKTAR_DIST');
  nameable(dist, 'dist', errors);

  const ignore = [
    ...(sources.repeated.get('ignore') ?? []),
    ...split(sources.env['VINKTAR_IGNORE'] ?? sources.dotenv?.['VINKTAR_IGNORE']),
  ];

  return {
    host,
    key,
    release,
    dist,
    urlPrefix: text('url-prefix', 'VINKTAR_URL_PREFIX') || '~/',
    concurrency: count(text('concurrency', 'VINKTAR_UPLOAD_CONCURRENCY'), 'concurrency', 1, 32, errors),
    timeoutMs: count(text('timeout', 'VINKTAR_HTTP_TIMEOUT'), 'timeout', 1, 3_600, errors, 1_000),
    maxRetries: count(text('retries', 'VINKTAR_HTTP_MAX_RETRIES'), 'retries', 1, 10, errors),
    headers: headersFrom(sources.repeated.get('header') ?? [], errors),
    ignore,
    extensions: extensionsFrom(text('ext', 'VINKTAR_EXTENSIONS')),
    rewriteSources: sources.flags.get('no-rewrite-sources') !== true,
    quiet: switched('quiet', 'VINKTAR_QUIET'),
    debug:
      switched('debug', 'VINKTAR_DEBUG') ||
      (sources.env['VINKTAR_LOG_LEVEL'] ?? '').trim().toLowerCase() === 'debug',
    strict: switched('strict', 'VINKTAR_STRICT'),
    allowFailure: switched('allow-failure', 'VINKTAR_ALLOW_FAILURE'),
    dryRun: sources.flags.get('dry-run') === true,
    inject: sources.flags.get('no-inject') !== true,
    errors,
    warnings,
  };
}

/** Trim, and refuse what is left if there is nothing left. */
function check(value: string, source: string, errors: string[]): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push(`${source} is empty. Remove it, or give it a value.`);

    return '';
  }

  return trimmed;
}

/**
 * A release or dist name, validated here so the bytes never leave.
 *
 * The server truncated an over-long release silently for a while, which is the worst of the
 * available options: the upload succeeds, the maps are stored under a name no SDK will ever
 * report, and nothing in the output says so.
 */
function nameable(value: string, field: 'release' | 'dist', errors: string[]): void {
  if (value === '') return;

  if (Buffer.byteLength(value) > MAX_NAME_BYTES) {
    errors.push(`The ${field} is longer than ${MAX_NAME_BYTES} bytes; the server will not store it under that name.`);
  }
  if (/[/\\]/.test(value)) errors.push(`The ${field} may not contain a slash.`);
  if (/\s/.test(value)) errors.push(`The ${field} may not contain whitespace.`);
  if (CONTROL.test(value)) errors.push(`The ${field} contains a control character.`);
  if (value === '.' || value === '..') errors.push(`"${value}" is not a usable ${field}.`);
}

function count(
  value: string,
  option: string,
  min: number,
  max: number,
  errors: string[],
  scale = 1,
): number | undefined {
  if (value === '') return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    errors.push(`--${option} must be a whole number between ${min} and ${max}, not "${value}".`);

    return undefined;
  }

  return parsed * scale;
}

/**
 * `--header 'Name: value'`, repeatable.
 *
 * The key header is added AFTER these by the HTTP layer, so `--header X-Vinktar-Key: …` cannot
 * displace it: the flag exists for a gateway in front of ingest, not to smuggle a second identity
 * past the one the rest of the CLI validated.
 */
function headersFrom(values: readonly string[], errors: string[]): Record<string, string> {
  const found: Record<string, string> = {};

  for (const value of values) {
    const colon = value.indexOf(':');
    if (colon <= 0) {
      errors.push(`--header "${value}" is not "Name: value".`);
      continue;
    }
    found[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
  }

  return found;
}

function extensionsFrom(value: string): string[] | undefined {
  const found = split(value);

  return found.length === 0 ? undefined : found;
}

function split(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
