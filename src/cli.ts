import { detectRelease } from './bundler/core.js';
import { doctor } from './commands/doctor.js';
import { inject } from './commands/inject.js';
import { resolvePosition } from './commands/resolve.js';
import { upload } from './commands/upload.js';
import { resolve, type Resolved } from './config.js';
import { loadDotEnv } from './env.js';
import { DEFAULT_HOST } from './limits.js';
import { UploadError } from './upload.js';
import { VERSION } from './version.js';

/**
 * Argument parsing, hand-rolled.
 *
 * A CLI whose only job is uploading files should not drag a dependency tree into someone's build
 * — and `npx` downloads whatever is in the manifest before it runs a single line, so every
 * dependency is latency on every CI run.
 */

const USAGE = `
vinktar — upload source maps so stack traces resolve to your original code

Usage
  npx @vinktarhq/cli sourcemaps upload <dir> --release <release> [options]
  npx @vinktarhq/cli sourcemaps inject <dir>
  npx @vinktarhq/cli sourcemaps resolve <map> --line <n> --column <n>
  npx @vinktarhq/cli doctor [--dir <dir>] [options]

Commands
  sourcemaps upload   Stamp each chunk with a debug id, then send the maps. Run
                      after your bundler, on every deploy.
  sourcemaps inject   Only the stamping. For pipelines that build on one machine
                      and upload from another; upload does this itself.
  sourcemaps resolve  Decode one position through a map, locally. Answers "would
                      this frame resolve, and to what" without a real error.
  doctor              Check the key, its scope, and the host. With --dir, also
                      whether the build's chunks and maps carry debug ids.

Identity
  --key <key>         A key with the "cli" scope (they start vnk_sk_). A public
                      write key is NOT enough. Defaults to $VINKTAR_CLI_KEY,
                      then $VINKTAR_KEY.
  --release <name>    The release these maps belong to. Must match what your SDK
                      reports. Defaults to $VINKTAR_RELEASE, then the CI commit,
                      then the full git SHA.
  --dist <name>       Build discriminator, if you ship several per release.
  --host <url>        Ingest host. Defaults to $VINKTAR_HOST or ${DEFAULT_HOST}.
  --url-prefix <p>    What the files are served under: /assets/, https://cdn.x/,
                      or ~/ (the default) for "wherever this is served from".

Selection
  --ignore <glob>     Skip matching chunks entirely. Repeatable. A skipped chunk
                      is neither stamped nor uploaded, so a rule cannot orphan
                      an id by removing a map its chunk still names.
  --ext <list>        Extensions to treat as chunks. Default js,cjs,mjs.

Behaviour
  --no-inject         Upload without stamping. Chunks with no debug id only
                      match frames by release + url, and you will be warned.
  --no-rewrite-sources  Send the map's "sources" exactly as the bundler wrote
                      them, including webpack:/// prefixes and absolute build
                      paths. By default those are tidied in the uploaded copy
                      only; the file on disk is never touched.
  --dry-run           Print what would be uploaded, including the URL each map
                      will be stored under. Sends nothing, and needs no key.
  --strict            Treat any warning as a failure (exit 2).
  --allow-failure     Never exit non-zero because the upload failed.
  --concurrency <n>   Requests in flight. Default 4, or what the server asks.
  --timeout <s>       Per request, before the size allowance. Default 30.
  --retries <n>       Attempts per request, including the first. Default 3.
  --header <h>        "Name: value", for a gateway in front of ingest.
                      Repeatable. Cannot displace the key header.
  --dotenv-file <p>   Read VINKTAR_* from this file. Ranks below the real
                      environment. (Not --env-file: Node owns that one and
                      would swallow it before this parser saw it.)

Output
  --quiet             Only errors and the summary.
  --debug             Everything, with the key redacted.
  -h, --help          This.
  -v, --version       Print the version.

Typical use, in a deploy script:

  npx @vinktarhq/cli sourcemaps upload ./dist --release "$GIT_SHA"
`;

export interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | boolean>;
  /** Values of repeatable flags, in order. `--ignore` and `--header` are the two. */
  readonly repeated: Map<string, string[]>;
}

/** Flags that may be given more than once, where the last value must not win. */
const REPEATABLE = new Set(['ignore', 'header']);

/** Flags that are switches. Everything else takes the next token as its value. */
const BOOLEAN_FLAGS = new Set([
  'dry-run',
  'no-inject',
  'no-rewrite-sources',
  'strict',
  'allow-failure',
  'quiet',
  'debug',
  'help',
  'h',
  'version',
  'v',
]);

export function parse(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const repeated = new Map<string, string[]>();

  const record = (name: string, value: string): void => {
    flags.set(name, value);
    if (!REPEATABLE.has(name)) return;

    const list = repeated.get(name) ?? [];
    list.push(value);
    repeated.set(name, list);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    const [name, inline] = splitFlag(token);

    if (inline !== null) {
      record(name, inline);
      continue;
    }

    // A switch never takes a value, so `--dry-run ./dist` leaves `./dist` as the directory. The
    // previous parser swallowed it as the switch's value and then reported a missing directory.
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }

    const next = argv[i + 1];
    // A bare flag followed by another flag is a boolean, not a flag with a flag for a value.
    if (next === undefined || next.startsWith('-')) {
      flags.set(name, true);
      continue;
    }

    record(name, next);
    i += 1;
  }

  return { positional, flags, repeated };
}

function splitFlag(token: string): [string, string | null] {
  const body = token.replace(/^--?/, '');
  const equals = body.indexOf('=');

  return equals === -1 ? [body, null] : [body.slice(0, equals), body.slice(equals + 1)];
}

function text(flags: Args['flags'], name: string, fallback = ''): string {
  const value = flags.get(name);

  return typeof value === 'string' ? value : fallback;
}

/**
 * Exit codes: 0 fine, 1 the thing did not work, 2 it worked and something is wrong anyway.
 *
 * Two rather than one for `--strict`, so a pipeline can tell "the upload failed" from "the upload
 * succeeded and half your chunks have no maps" — which are different problems with different
 * owners, and merging them means neither gets fixed.
 */
export async function run(argv: readonly string[], log = console.log, fail = console.error): Promise<number> {
  const { positional, flags, repeated } = parse(argv);

  // Before the usage branch: `vinktar --version` has no positional, and used to print usage and
  // exit 1, which made the version unreachable from the command line.
  if (flags.has('version') || flags.has('v')) {
    log(VERSION);

    return 0;
  }

  if (flags.has('help') || flags.has('h') || positional.length === 0) {
    log(USAGE.trim());

    return positional.length === 0 ? 1 : 0;
  }

  const dotenvPath = text(flags, 'dotenv-file');
  const dotenv = dotenvPath === '' ? null : await loadDotEnv(dotenvPath);
  if (dotenv !== null && !dotenv.found) {
    fail(`No such file: ${dotenvPath}`);

    return 1;
  }
  for (const warning of dotenv?.warnings ?? []) fail(`WARNING: ${warning}`);

  const config = resolve({
    flags,
    repeated,
    env: process.env,
    ...(dotenv === null ? {} : { dotenv: dotenv.values }),
  });

  for (const error of config.errors) fail(error);
  if (config.errors.length > 0) return 1;
  for (const warning of config.warnings) fail(`WARNING: ${warning}`);

  const say = config.quiet ? (): void => {} : log;
  const debug = config.debug ? (line: string): void => fail(`[debug] ${redact(line, config.key)}`) : (): void => {};

  try {
    if (positional[0] === 'doctor') return await runDoctor(config, flags, say, fail);

    if (positional[0] !== 'sourcemaps') {
      fail(`Unknown command "${positional[0]}". Try --help.`);

      return 1;
    }

    const action = positional[1];

    if (action === 'resolve') return await runResolve(positional[2], flags, log, fail);

    const directory = positional[2];
    if (directory === undefined) return missing('a directory', 'e.g. ./dist', fail);

    if (action === 'inject') return await runInject(directory, config, say, fail);
    if (action === 'upload') return await runUpload(directory, config, say, fail, debug);

    fail(`Unknown sourcemaps action "${action ?? ''}". Try inject, upload or resolve.`);

    return 1;
  } catch (error) {
    if (error instanceof UploadError) {
      fail('');
      fail(error.message);
      if (error.hint !== undefined) fail(error.hint);
      if (!config.debug) fail('Re-run with --debug for the full exchange.');

      return config.allowFailure ? 0 : 1;
    }

    fail(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.cause !== undefined) {
      fail(`caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
    }

    return 1;
  }
}

async function runDoctor(
  config: Resolved,
  flags: Args['flags'],
  log: (line: string) => void,
  fail: (line: string) => void,
): Promise<number> {
  if (config.key === '') return missing('a key', '--key, $VINKTAR_CLI_KEY or $VINKTAR_KEY', fail);

  const dir = text(flags, 'dir');
  const ok = await doctor(config.host, config.key, log, {
    ...(dir === '' ? {} : { dir }),
    ignore: config.ignore,
    ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
  });

  return ok ? 0 : 1;
}

async function runInject(
  directory: string,
  config: Resolved,
  log: (line: string) => void,
  fail: (line: string) => void,
): Promise<number> {
  log(`Injecting debug ids into ${directory}…`);
  const result = await inject(directory, log, {
    ignore: config.ignore,
    ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
  });

  log('');
  for (const line of result.warnings) fail(`WARNING: ${line}`);
  log(
    `Injected ${result.injected}, already stamped ${result.skipped}` +
      `${result.adopted > 0 ? `, ${result.adopted} adopted from the bundler` : ''}` +
      `${result.repaired > 0 ? `, ${result.repaired} map(s) repaired` : ''}` +
      `${result.empty > 0 ? `, ${result.empty} empty map(s) left alone` : ''}.`,
  );
  if (result.withoutMaps > 0) {
    log(`${result.withoutMaps} file(s) had no .map beside them and were left alone.`);
    log('If that is unexpected, your bundler is not emitting source maps for them.');
  }

  return config.strict && result.warnings.length > 0 ? 2 : 0;
}

async function runUpload(
  directory: string,
  config: Resolved,
  log: (line: string) => void,
  fail: (line: string) => void,
  debug: (line: string) => void,
): Promise<number> {
  // Detected here rather than demanded, exactly as the plugins do: a deploy script that already
  // knows its commit should not have to say so twice. Announced when it was detected, because a
  // release nobody chose is a release nobody checks, and the SDK has to report the same one.
  const release = config.release === '' ? detectRelease(process.env) : config.release;
  if (config.release === '' && release !== '') log(`Release not given; using ${release}.`);

  // A dry run opens no socket, so it needs no key: "what would this upload" is the first thing
  // anyone asks, and needing a production secret to answer it is why nobody asked.
  if (!config.dryRun && config.key === '') {
    return missing('a key', '--key, $VINKTAR_CLI_KEY or $VINKTAR_KEY', fail);
  }
  if (!config.dryRun && release === '') {
    return missing('a release', '--release or $VINKTAR_RELEASE, matching what your SDK reports', fail);
  }

  debug(`host ${config.host}, release ${release}, key ${config.key}`);
  log(`${config.dryRun ? 'Checking' : 'Uploading'} source maps in ${directory}…`);

  const summary = await upload(
    directory,
    {
      host: config.host,
      key: config.key,
      release,
      ...(config.dist === '' ? {} : { dist: config.dist }),
      urlPrefix: config.urlPrefix,
      dryRun: config.dryRun,
      inject: config.inject,
      rewriteSources: config.rewriteSources,
      root: directory,
      ignore: config.ignore,
      ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
      ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
      ...(Object.keys(config.headers).length === 0 ? {} : { headers: config.headers }),
    },
    log,
    // Warnings go to stderr so a CI log filter cannot miss them; the exit code stays 0 unless
    // --strict says otherwise, because the maps are still useful, just less so.
    fail,
  );

  // Only a build with no maps at all is a failure. "Everything was already stored" is the
  // successful shape of a redeploy, and it is reachable: the upload asks the server what it holds
  // before sending, so an unchanged build sends nothing and says so.
  const found = summary.uploaded + summary.alreadyStored + summary.oversized;
  if (found === 0 && !config.dryRun) {
    log('');
    log('No source maps found. Run your bundler with source maps enabled first.');

    return config.allowFailure ? 0 : 1;
  }

  if (!config.dryRun) {
    log(
      summary.uploaded === 0
        ? `Every map for release "${release}" was already stored.`
        : `Release "${release}".`,
    );
  }

  const problems =
    summary.warnings.length + summary.oversized + summary.uninjected + summary.skipped + summary.duplicates;

  return config.strict && problems > 0 ? 2 : 0;
}

async function runResolve(
  mapPath: string | undefined,
  flags: Args['flags'],
  log: (line: string) => void,
  fail: (line: string) => void,
): Promise<number> {
  if (mapPath === undefined) return missing('a map', 'e.g. ./dist/app.js.map', fail);

  const line = Number(text(flags, 'line', '0'));
  const column = Number(text(flags, 'column', '1'));

  if (!Number.isInteger(line) || line < 1) {
    return missing('a line', '--line <n>, 1-based, as a stack frame reports it', fail);
  }
  if (!Number.isInteger(column) || column < 1) {
    return missing('a column', '--column <n>, 1-based', fail);
  }

  const result = await resolvePosition(mapPath, line, column);
  for (const warning of result.warnings) fail(`WARNING: ${warning}`);

  if (result.debugId !== null) log(`debug id  ${result.debugId}`);

  if (result.position === null) {
    log(`Nothing resolves at ${line}:${column}.`);

    return 1;
  }

  log(`${result.position.source}:${result.position.line}:${result.position.column}${result.position.name === null ? '' : `  (${result.position.name})`}`);

  if (result.context.length > 0) {
    log('');
    for (const entry of result.context) {
      log(`${entry.here ? '>' : ' '} ${String(entry.line).padStart(5)} | ${entry.text}`);
    }
  }

  return 0;
}

/** Never print a key, even under --debug: CI logs are archived and shared far more than intended. */
function redact(line: string, key: string): string {
  return key.length > 8 ? line.split(key).join(`${key.slice(0, 7)}…redacted`) : line;
}

function missing(what: string, how: string, fail: (line: string) => void): number {
  fail(`Missing ${what}. Pass ${how}.`);

  return 1;
}

export { VERSION };
