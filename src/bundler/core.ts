import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';

import { upload, type StoredMap, type UploadSummary } from '../commands/upload.js';
import { deriveDebugId, existingDebugId, inject } from '../debug-id.js';
import { allFiles, discover } from '../discover.js';
import { DEFAULT_HOST } from '../limits.js';
import { UploadError, type UploadOptions } from '../upload.js';

/**
 * Everything the bundler plugins share, with no bundler in it.
 *
 * There are two operations and five bundlers. The operations are the part worth getting right —
 * where the debug id comes from, when it is safe to inject, what the upload skips — and having
 * them once means a fix lands in all five rather than in whichever one someone remembered.
 *
 * Written by hand rather than on `unplugin`, which is the obvious tool for this: this package
 * ships zero runtime dependencies, and the per-bundler surface here is one hook each.
 */

export interface BundlerOptions {
  /**
   * Turn the whole plugin into a no-op, before any environment, git or network work happens.
   *
   * For a config that is reused by something other than a build — vitest, Storybook, a preview
   * server — where stamping chunks and shelling out to git is pure cost. Also settable with
   * `VINKTAR_DISABLE=1`, which is what a CI matrix can use without editing the config.
   */
  disable?: boolean;
  /**
   * Stamp debug ids into the chunks. Default true.
   *
   * Turn it off for a build under a strict CSP or with subresource integrity computed elsewhere,
   * where nothing may modify a chunk after it is hashed by another tool. The maps are still
   * uploaded; frames then match by release + url alone, which is weaker but not nothing.
   */
  injectDebugIds?: boolean;
  /** What the built files are served under, for release+url matching. */
  urlPrefix?: string;
  /**
   * Upload after the build. Default **true**, with a warning when no key is available.
   *
   * Not "true when a key is set": that made a CI job with an unwired secret indistinguishable
   * from one that was never meant to upload, and both said nothing. Setting this to `false` turns
   * the whole feature off, deletion included.
   */
  uploadSourcemaps?: boolean;
  /**
   * Remove the maps from the build output afterwards. Default **true**.
   *
   * A source map is the application's original source. The bundler only emitted one because this
   * plugin asked it to, so leaving it in the output directory publishes the whole codebase to
   * anyone who guesses `app.js.map` — which is how it shipped before, and what `sourcemap:
   * 'hidden'` exists to prevent. Set `false` when the maps are meant to be served.
   */
  deleteSourcemapsAfterUpload?: boolean;
  /** Build discriminator, when several builds share one release. */
  dist?: string;
  /** The release these maps belong to. Defaults to the CI commit, then the git SHA. */
  release?: string;
  /** Ingest host. Defaults to `$VINKTAR_HOST`, then the public one. */
  host?: string;
  /** The `cli`-scoped key. Defaults to `$VINKTAR_CLI_KEY`. */
  key?: string;
  /**
   * Fail the build when the upload fails. Default **false**, or `VINKTAR_STRICT=1`.
   *
   * Without it a failed upload is a warning: an outage here, a revoked key or a checkout with no
   * git is not a reason for somebody's deploy to stop. The maps of a failed upload are left where
   * the bundler wrote them, deletion or not, so a team whose output directory is published as it
   * stands, and who would rather not ship than ship maps, wants this on.
   */
  strict?: boolean;
  /**
   * Called with the failure instead of the warning or the throw, `strict` or not. Throw from it to
   * fail the build.
   */
  errorHandler?: (error: Error) => void;
  /** Per request, in milliseconds, before the size allowance. Default 30 000, or `$VINKTAR_HTTP_TIMEOUT` in seconds. */
  timeoutMs?: number;
  /** Attempts per request, including the first. Default 3, or `$VINKTAR_HTTP_MAX_RETRIES`. */
  maxRetries?: number;
  /** Requests in flight. Default 4, or what the server asks for, or `$VINKTAR_UPLOAD_CONCURRENCY`. */
  concurrency?: number;
  /**
   * For the whole upload, in milliseconds. Default 300 000, or `$VINKTAR_UPLOAD_DEADLINE` in
   * seconds. When it passes the upload is abandoned and treated as any other failed one.
   */
  deadlineMs?: number;
  /** Suppress the plugin's own output. Warnings about lost symbolication are still printed. */
  silent?: boolean;
}

export interface Stamped {
  readonly code: string;
  readonly debugId: string;
  /**
   * The generated line the snippet was inserted at, or `null` when it was appended. The chunk's
   * map must gain one empty group at this index; every plugin does that for its own map.
   */
  readonly line: number | null;
  /** False when the chunk already carried everything, so the caller can skip writing it back. */
  readonly changed: boolean;
}

/**
 * Stamp one chunk, and say what its map now needs.
 *
 * Must run AFTER minification and BEFORE the bundler hashes the output. Minifiers strip comments,
 * so an id injected earlier loses its `//# debugId=` line; the embedded marker survives that, but
 * the hash has to cover the snippet or the filename describes bytes that are not on disk.
 *
 * An id the chunk already carries is kept rather than replaced — Rollup's `output.sourcemapDebugIds`
 * and webpack's `debugIds` stamp one themselves, and minting a competing id here would file the map
 * under something no stack frame reports.
 */
export function stamp(code: string, options: { prepend?: boolean } = {}): Stamped {
  const debugId = existingDebugId(code) ?? deriveDebugId(code);
  const injection = inject(code, debugId, options);

  return {
    code: injection.code,
    debugId,
    line: injection.line,
    changed: injection.code !== code,
  };
}

/**
 * Whether the plugin should do nothing at all.
 *
 * Checked before the release is detected, because detecting it shells out to git — and a config
 * shared with vitest would then run `git rev-parse` on every test file.
 */
export function disabled(options: BundlerOptions, env: Record<string, string | undefined> = process.env): boolean {
  if (options.disable === true) return true;

  return truthy(env['VINKTAR_DISABLE']);
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Things about the environment that will make this not work, said once.
 *
 * Both of these produce the same symptom — the upload silently does nothing — and both are
 * invisible from inside the build. Turborepo in particular filters the environment down to what a
 * task declares, so `VINKTAR_CLI_KEY` is simply absent and the plugin reports a missing key that
 * the user can see perfectly well in their own shell.
 */
export function environmentWarnings(
  outDir: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const warnings: string[] = [];

  if (env['TURBO_HASH'] !== undefined && (env['VINKTAR_CLI_KEY'] ?? '') === '') {
    warnings.push(
      'Running under Turborepo, which passes only the environment a task declares. Add VINKTAR_* to that task\'s passThroughEnv, or the key will never reach this build.',
    );
  }

  if (outDir.split(sep).includes('node_modules')) {
    warnings.push(
      `The build output is inside node_modules (${outDir}). Those files are not served, so uploading their maps files them under URLs no frame will ever report.`,
    );
  }

  return warnings;
}

/** True when this file is one we stamp: JavaScript, not a map, not CSS. */
export function isScript(name: string): boolean {
  return /\.[cm]?js$/.test(name.split('?')[0] ?? name);
}

/**
 * The upload-then-delete half of a build, as one object per plugin instance.
 *
 * Split in two because Rollup and Vite are: `writeBundle` fires once per output and is the only
 * hook that knows where the files went, while deletion has to wait until every output is on the
 * server. A build with a client bundle and an SSR bundle would otherwise delete the first one's
 * maps while the second was still being written.
 */
export interface Session {
  /** Upload everything under `outDir`. Safe to call repeatedly; the server dedupes by content. */
  upload(outDir: string): Promise<void>;
  /** Remove the maps from every directory uploaded so far, if that is configured. */
  cleanup(): Promise<void>;
}

export function session(options: BundlerOptions, env: Record<string, string | undefined> = process.env): Session {
  const log = (line: string): void => {
    if (options.silent !== true) console.log(`[vinktar] ${line}`);
  };
  // Warnings are never silenced. `silent` means "do not narrate a successful build"; every line
  // that reaches here says symbolication is about to be worse than the user thinks it is.
  const warn = (line: string): void => {
    console.warn(`[vinktar] ${line}`);
  };

  const key = options.key ?? env['VINKTAR_CLI_KEY'] ?? '';
  // Default TRUE, not "only when a key is set". A build with no key is the case worth talking
  // about — a CI job whose secret was never wired up looks exactly like a working one — so it
  // takes this path and warns, instead of quietly deciding the user meant to skip it.
  const wantsUpload = options.uploadSourcemaps !== false;
  // Deletion is the second half of uploading, so switching the upload off switches it off too.
  // A build with no key still deletes: the maps are the application's source sitting in a
  // directory that is about to be served. A FAILED upload does not — see `failed` below.
  const wantsDelete = options.deleteSourcemapsAfterUpload ?? wantsUpload;
  const strict = options.strict ?? truthy(env['VINKTAR_STRICT']);

  /**
   * Per directory: the maps confirmed on the server, or `null` when no upload was attempted. A
   * directory whose upload failed is not in here at all, so `cleanup` never visits it.
   */
  const seen = new Map<string, StoredMap[] | null>();

  /**
   * An upload was attempted and did not work. Never fatal unless somebody asked for that.
   *
   * This runs inside somebody else's build, and the only thing it can honestly break is their
   * deploy: the application is fine, it is this vendor, this key or this checkout that is not. So
   * it warns, with the same message and hint the CLI prints, and the build finishes.
   *
   * The maps stay. Deleting them is the last step of a successful upload, and there was not one:
   * these are the only copy, and the next run (or `sourcemaps upload` on the same directory) can
   * still send them. It does mean the output directory holds the application's source, which is
   * said in so many words, because a deploy that publishes that directory publishes them.
   */
  const failed = (outDir: string, failure: Error): void => {
    seen.delete(outDir);

    const message = /[.!?]$/.test(failure.message) ? failure.message : `${failure.message}.`;
    const hint = failure instanceof UploadError && failure.hint !== undefined ? ` ${failure.hint}` : '';
    const kept = wantsDelete
      ? ` The source maps were left in place in ${outDir}, and a deploy that publishes that directory publishes them.`
      : '';

    if (options.errorHandler !== undefined) {
      options.errorHandler(failure);
      if (kept !== '') warn(kept.trim());

      return;
    }

    if (strict) {
      throw new Error(`source-map upload failed: ${message}${hint}`, { cause: failure });
    }

    warn(`source-map upload failed: ${message}${hint}`);
    warn(
      `The build carries on, and errors from this release keep their minified stack traces.${kept} ` +
        'Set strict: true, or VINKTAR_STRICT=1, to fail the build instead.',
    );
  };

  let announced = false;

  return {
    async upload(outDir: string): Promise<void> {
      if (outDir === '' || (!wantsUpload && !wantsDelete)) return;

      if (!announced) {
        announced = true;
        for (const line of environmentWarnings(outDir, env)) warn(line);
      }

      if (!wantsUpload) {
        seen.set(outDir, null);

        return;
      }

      if (key === '') {
        // Never fatal: a contributor running `pnpm build` on a laptop has no key and does not
        // need one. Loud anyway, and specific about what it costs, because the failure mode is
        // silent minified stack traces weeks later.
        warn(
          wantsDelete
            ? 'VINKTAR_CLI_KEY is not set: the source maps will be deleted from the build output and NOT uploaded, so this release cannot be symbolicated.'
            : 'VINKTAR_CLI_KEY is not set: source maps were not uploaded, so this release cannot be symbolicated.',
        );
        seen.set(outDir, null);

        return;
      }

      let summary: UploadSummary;
      try {
        const release = (options.release ?? detectRelease(env)).trim();
        // Checked here, before anything is sent. Detection comes back empty on a machine with no
        // CI variables and no git (a Docker build stage, usually), and the server's answer to an
        // empty release is `missing_release` with a hint about flags this plugin does not have.
        if (release === '') {
          throw new UploadError(
            'There is no release to file the maps under.',
            0,
            'missing_release',
            'None was given, no CI commit variable is set, and git found no commit here. Pass `release`, or set VINKTAR_RELEASE, to the value your SDK reports.',
          );
        }

        summary = await upload(
          outDir,
          {
            host: (options.host ?? env['VINKTAR_HOST'] ?? DEFAULT_HOST).replace(/\/+$/, ''),
            key,
            release,
            ...(options.dist === undefined || options.dist === '' ? {} : { dist: options.dist }),
            urlPrefix: options.urlPrefix ?? '~/',
            dryRun: false,
            // The chunks were stamped as they were rendered; a second pass would re-read every
            // file in the build and change nothing.
            inject: false,
            ...shaping(options, env, warn),
          },
          log,
          warn,
        );
      } catch (error) {
        // Everything, not only what the server said: a map that is not JSON and a directory that
        // cannot be read throw from the same call, and cost the build exactly as much.
        failed(outDir, error instanceof Error ? error : new Error(String(error)));

        return;
      }

      seen.set(outDir, summary.storedMaps.slice());
    },

    async cleanup(): Promise<void> {
      if (!wantsDelete) return;

      let removed = 0;
      for (const [dir, stored] of seen) removed += await remove(dir, stored, warn);

      if (removed > 0) log(`removed ${removed} source map(s) from the build output`);
      seen.clear();
    },
  };
}

/**
 * Timeout, retries, concurrency and deadline: the option, then the variable the CLI reads.
 *
 * The variables are in seconds where the CLI's flags are, so one pipeline setting means the same
 * thing to both. A value that is not a positive whole number is ignored with a warning rather than
 * refused: a typo in a CI variable is not worth a build either.
 */
function shaping(
  options: BundlerOptions,
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): Pick<UploadOptions, 'timeoutMs' | 'maxRetries' | 'concurrency' | 'deadlineMs'> {
  const read = (given: number | undefined, name: string, scale: number): number | undefined => {
    if (given !== undefined) return given;

    const raw = (env[name] ?? '').trim();
    if (raw === '') return undefined;

    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed * scale;

    warn(`${name} is "${raw}", which is not a whole number above zero; using the default.`);

    return undefined;
  };

  const found = {
    timeoutMs: read(options.timeoutMs, 'VINKTAR_HTTP_TIMEOUT', 1_000),
    maxRetries: read(options.maxRetries, 'VINKTAR_HTTP_MAX_RETRIES', 1),
    concurrency: read(options.concurrency, 'VINKTAR_UPLOAD_CONCURRENCY', 1),
    deadlineMs: read(options.deadlineMs, 'VINKTAR_UPLOAD_DEADLINE', 1_000),
  };

  return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined));
}

/**
 * Upload and clean up in one call, for the bundlers with a single end-of-build hook.
 */
export async function finish(
  outDir: string,
  options: BundlerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const run = session(options, env);
  await run.upload(outDir);
  await run.cleanup();
}

/**
 * Delete the maps under one directory, and unpoint the chunks that referenced them.
 *
 * `stored` names the maps the server confirmed; `null` means no upload was attempted (no key, or
 * uploading switched off with deletion left on) and every map goes, because the reason for
 * deleting them — they are the application's source, sitting in a public directory — has nothing
 * to do with whether an upload happened. A directory whose upload was attempted and failed never
 * gets here.
 *
 * A map whose bytes changed since it was indexed is left alone. Turbopack rewrites files while
 * later stages are still running, and deleting one there removes a map the server never got.
 */
async function remove(
  dir: string,
  stored: readonly StoredMap[] | null,
  warn: (line: string) => void,
): Promise<number> {
  const { artifacts } = await discover(dir).catch(() => ({ artifacts: [] }));
  const hashes = new Map<string, string>();
  for (const entry of stored ?? []) hashes.set(entry.map, entry.sha256);

  let removed = 0;

  for (const artifact of artifacts) {
    if (artifact.map === null) continue;
    if (stored !== null && !hashes.has(artifact.map)) continue;

    const expected = hashes.get(artifact.map);
    if (expected !== undefined) {
      const actual = await readFile(artifact.map).then((raw) => sha256(raw)).catch(() => null);
      if (actual === null) continue;
      if (actual !== expected) {
        warn(`${artifact.map} changed after it was uploaded; leaving it in place.`);
        continue;
      }
    }

    try {
      await unlink(artifact.map);
      removed += 1;
    } catch {
      continue;
    }

    await unpoint(artifact.file, warn);
  }

  // CSS maps are never uploaded — the server symbolicates JavaScript — but a build that emitted
  // them publishes the stylesheets' sources just as plainly, and `sourcemap: true` emits both.
  // They are not artifacts, so they need their own sweep rather than a filter over the ones above.
  for (const file of await allFiles(dir).catch(() => [])) {
    if (!file.endsWith('.css.map')) continue;
    try {
      await unlink(file);
      removed += 1;
    } catch {
      continue;
    }

    await unpoint(file.slice(0, -'.map'.length), warn);
  }

  return removed;
}

/**
 * Drop a trailing `//# sourceMappingURL=` from a chunk whose map has just been deleted.
 *
 * Only the trailing one, and only when nothing but a `//# debugId=` line follows it: a comment in
 * the middle of a chunk belongs to something concatenated into it, and removing a line from there
 * would shift every mapping below. Left in place, the comment makes every devtools session fetch
 * a 404 and report a broken build.
 */
async function unpoint(file: string, warn: (line: string) => void): Promise<void> {
  let code: string;
  try {
    code = await readFile(file, 'utf8');
  } catch {
    return;
  }

  // Both spellings: `//#` for JavaScript and `/*# … */` for CSS, which is the same comment in the
  // only syntax a stylesheet has.
  const stripped = code.replace(
    /\n?(?:\/\/[#@] sourceMappingURL=[^\n]*|\/\*[#@] sourceMappingURL=[^\n]*?\*\/)(?=(?:\s*\n\/\/# debugId=[^\n]*)?\s*$)/,
    '',
  );
  if (stripped === code) return;

  try {
    await writeFile(file, stripped, 'utf8');
  } catch (error) {
    warn(`could not remove the sourceMappingURL comment from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Re-export so plugins can write an id and a line shift into a map without a second import. */
export { injectIntoMap, mapDebugId } from '../debug-id.js';

/**
 * The release: the commit being built.
 *
 * CI first. A shallow checkout — which is what every default CI clone is — often has no usable git
 * metadata, and falling straight to git produced an EMPTY release: every frame then lost its
 * release+url match, leaving the debug id as the only thing holding symbolication together.
 *
 * The FULL sha, never a short one. A short sha is a prefix whose length varies by tool (7 from
 * `git rev-parse --short`, 8 from GitLab, 12 from some deploy scripts), and the SDK reporting one
 * length while the CLI uploaded another is a release mismatch that looks exactly like no release
 * at all. Both sides read the same variables, so both get the same 40 characters.
 */
export function detectRelease(env: Record<string, string | undefined> = process.env): string {
  const explicit = env['VINKTAR_RELEASE'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();

  const pull = pullRequestHead(env);
  if (pull !== null) return pull;

  for (const name of [
    'GITHUB_SHA',
    'VERCEL_GIT_COMMIT_SHA',
    'CF_PAGES_COMMIT_SHA',
    'CI_COMMIT_SHA',
    'BITBUCKET_COMMIT',
    'BUILD_SOURCEVERSION',
    'COMMIT_REF',
  ]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/**
 * The commit a GitHub pull-request build is actually building.
 *
 * On `pull_request`, `GITHUB_SHA` is a synthetic merge commit that exists only inside the runner:
 * it is in nobody's history, so a release named after it matches nothing the deployed application
 * will ever report. The head sha is in the event payload.
 */
function pullRequestHead(env: Record<string, string | undefined>): string | null {
  if (env['GITHUB_EVENT_NAME'] !== 'pull_request' && env['GITHUB_EVENT_NAME'] !== 'pull_request_target') {
    return null;
  }

  const path = env['GITHUB_EVENT_PATH'];
  if (path === undefined || path === '') return null;

  try {
    // Read synchronously on purpose: this runs inside a bundler's config hook, which cannot await.
    const payload: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const sha = (payload as { pull_request?: { head?: { sha?: unknown } } })?.pull_request?.head?.sha;

    return typeof sha === 'string' && sha !== '' ? sha : null;
  } catch {
    return null;
  }
}
