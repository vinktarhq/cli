import { DEFAULT_HOST, REQUIRED_SCOPE } from '../limits.js';
import { audit } from './inject.js';

export interface DoctorOptions {
  /** A build directory to audit for debug ids, on top of the key and host checks. */
  readonly dir?: string;
  readonly ignore?: readonly string[];
  readonly extensions?: readonly string[];
}

/**
 * Answers "is this key going to work, and for what", and with `--dir`, "is this build stamped".
 *
 * Every failure mode of a source-map setup looks identical from the outside (stack traces stay
 * minified), so this exists to distinguish "wrong key", "right key, wrong scope", "wrong host",
 * "the build was never injected" and "fine, your maps just have not uploaded yet" before anyone
 * spends an afternoon on it.
 */
export async function doctor(
  host: string,
  key: string,
  log: (line: string) => void,
  options: DoctorOptions = {},
): Promise<boolean> {
  log(`host  ${host}${host === DEFAULT_HOST ? '' : '   (custom)'}`);
  log(`key   ${key.slice(0, 11)}…${key.slice(-4)}`);
  log('');

  // Local, so it runs before the network: an unreachable host should not hide a broken build.
  let buildOk = true;
  if (options.dir !== undefined) {
    buildOk = await checkBuild(options.dir, log, options);
    log('');
  }

  const health = await probe(`${host}/v1/health`);
  log(health.ok ? 'reachable          yes' : `reachable          NO — ${health.detail}`);
  if (!health.ok) {
    log('');
    log('Nothing else can be checked until the host responds. Check --host and your network.');

    return false;
  }

  // An empty upload is the cheapest way to ask "would you accept this key". It never stores
  // anything: the server rejects it for a missing release long before it looks at any file.
  const form = new FormData();
  const response = await fetch(`${host}/v1/sourcemaps`, {
    method: 'POST',
    headers: { 'X-Vinktar-Key': key },
    body: form,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const code = String(payload['error'] ?? '');

  if (response.status === 401) {
    log('key accepted       NO — the key is unknown or revoked');

    return false;
  }

  if (code === 'cli_scope_required') {
    log('key accepted       yes');
    log(`upload scope       NO — this key lacks the "${REQUIRED_SCOPE}" scope`);
    log('');
    log(`Source-map upload needs a key with the "${REQUIRED_SCOPE}" scope; a write key is not enough.`);
    log('Create one in project settings and pass it with --key.');

    return false;
  }

  // Reaching the release check means auth and scope both passed.
  log('key accepted       yes');
  log('upload scope       yes');
  log('');
  log(buildOk ? 'Ready to upload.' : 'Fix the build above, then upload.');

  return buildOk;
}

/**
 * Two counts and a verdict. "Not injected" is a warning (release + url still matches); a map
 * whose id differs from its chunk's is a failure, because that map can never be found.
 */
async function checkBuild(
  dir: string,
  log: (line: string) => void,
  options: DoctorOptions,
): Promise<boolean> {
  let found: Awaited<ReturnType<typeof audit>>;
  try {
    found = await audit(dir, options);
  } catch (error) {
    log(`build              NO — cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);

    return false;
  }

  const total = found.injected + found.notInjected;
  log(`build              ${dir}`);

  for (const line of found.warnings) log(`  note: ${line}`);

  if (total === 0) {
    log('chunks with maps   none');
    log(found.withoutMaps > 0
      ? `${found.withoutMaps} chunk(s) have no .map beside them. Build with source maps enabled.`
      : 'No JavaScript found. Is that the build output directory?');

    return false;
  }

  log(`chunks injected    ${found.injected} of ${total}${found.notInjected > 0 ? ` (${found.notInjected} without a debug id)` : ''}`);
  if (found.withoutMaps > 0) log(`without a map      ${found.withoutMaps}, left alone`);

  // A chunk naming an id that nothing registers at runtime is the quietest failure here: the map
  // is filed correctly and no frame ever asks for it, because the snippet was stripped or was
  // never there. Rollup's own `output.sourcemapDebugIds` produces exactly this on its own.
  if (found.unregistered > 0) {
    log(`registered at run  NO — ${found.unregistered} chunk(s) name a debug id but do not register it`);
    log('Those ids come from the bundler, not from this plugin. Frames from them match by release + url only.');
  }

  const blank = found.entries.filter((entry) => entry.empty).length;
  if (blank > 0) log(`empty maps         ${blank}, nothing to resolve (usually an HTML entry facade)`);

  const bare = found.entries.filter((entry) => !entry.empty && !entry.hasSourcesContent);
  if (bare.length > 0) {
    log(`sourcesContent     ${bare.length} map(s) carry none`);
    log('Frames from those resolve to a file and a line, with no source text to show. Turn on');
    log('`sourcesContent` in your bundler, or upload the sources alongside.');
  }

  // Two snippets in one chunk means it was stamped twice: the output directory held the previous
  // build when this one ran, so the id is right and the bytes are a build older than they look.
  const twice = found.entries.filter((entry) => entry.snippets > 1).length;
  if (twice > 0) {
    log(`stamped twice      ${twice} chunk(s)`);
    log('The output directory was not cleaned before the build. Delete it and rebuild.');
  }

  if (found.mismatched > 0) {
    log(`maps match         NO — ${found.mismatched} map(s) do not carry their chunk's debug id`);
    for (const entry of found.entries) {
      if (entry.chunkId !== null && entry.mapId !== entry.chunkId) {
        log(`  ${entry.relative}: chunk ${entry.chunkId}, map ${entry.mapId ?? 'none'}`);
      }
    }
    log('The map was rebuilt after the chunk was stamped. Rebuild, then upload (which injects again).');

    return false;
  }

  log(`maps match         yes${found.notInjected > 0 ? ' (for the injected chunks)' : ''}`);
  if (found.notInjected > 0) {
    log(`${found.notInjected} chunk(s) have no debug id; frames from them will only match by release + url. "sourcemaps upload" injects by default.`);
  }

  return true;
}

async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    return { ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
  }
}
