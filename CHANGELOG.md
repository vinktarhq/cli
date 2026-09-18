# Changelog

## 0.3.0

### A failed upload no longer fails your build

This changes what happens by default, so read it before upgrading.

Until now a bundler plugin threw when the upload failed and deletion was on, and
`sourcemaps upload` exited 1 unless `--allow-failure` was passed. Either way an outage here, a
revoked key or a full quota stopped somebody's deploy, over stack traces. Now:

- **The plugins warn and let the build finish**, whatever went wrong: a 5xx, a timeout, a 429 that
  outlasted its retries, a refused key, the wrong scope, a full quota, no release, a directory that
  cannot be read, a map that is not JSON. The warning carries the same message and hint as before.
- **The maps of a failed upload are not deleted**, even with `deleteSourcemapsAfterUpload` on. They
  are the only copy. The warning names the directory and says that a deploy which publishes it
  publishes them. This also holds when an `errorHandler` is given, where they used to be deleted.
- **`strict: true`, or `VINKTAR_STRICT=1`, restores failing the build.** `errorHandler` still takes
  precedence over both.
- **`sourcemaps upload` exits 0 when the upload fails**, including for a missing key or release, an
  empty `--release`, a missing `--dotenv-file`, an unreadable directory, a broken map and a build
  with no maps at all, none of which `--allow-failure` used to cover. stderr starts with
  `WARNING: source maps were not uploaded.` so the deploys that went out without maps can be found.
  `--strict`, or `VINKTAR_STRICT=1`, makes it exit 1.
- `--strict` now has one meaning everywhere, nothing is forgiven: a failed upload exits 1, and
  warnings from an upload or an inject that worked still exit 2. `sourcemaps inject` is unchanged.
- `--allow-failure` and `VINKTAR_ALLOW_FAILURE` are accepted and ignored, so existing pipelines keep
  running. `--strict` wins when both are given.
- A command that was written wrong always exits 1: an unknown command, a value that does not parse,
  and, new in this release, **an unknown flag**, which used to be ignored. The exception is
  `sourcemaps upload` without `--strict`, which prints `WARNING: unknown flag …, ignored` and
  carries on, so a stray flag in a deploy that worked yesterday does not stop it today. Read the
  warning: `--strcit` is a pipeline that believes it is strict.
- The plugins check for an empty release before sending anything, instead of relaying the server's
  `missing_release` and its hint about CLI flags.

### Nothing waits for ever

- A whole upload has a deadline: `--deadline <s>`, `VINKTAR_UPLOAD_DEADLINE`, or `deadlineMs`, five
  minutes by default, covering the pre-flight, every batch and every retry. Past it the requests in
  flight are aborted and the upload counts as failed. `upload()` also takes a `signal`.
- Once one batch has failed for good, no further batch starts and the ones in flight are aborted.
  The other runners used to work through the rest of the list, retries and all, before the failure
  was reported.
- The plugins take `timeoutMs`, `maxRetries`, `concurrency` and `deadlineMs`, and read the same
  variables as the CLI. They passed none of them before.
- Behind a proxy the request timeout measured the gap between two bytes, so a proxy that dripped a
  response never tripped it. It bounds the whole request now, as it does without a proxy, and a
  timed-out request is retried like any other transient failure on both paths.
- Every request made by `login`, `logout`, `tools`, `call` and the shortcuts has a 30 second
  timeout, and `doctor`'s key check has the 10 seconds its health check already had. The five
  minute wait for the browser in `login` is separate and unchanged.

### Fixes

- `doctor` reported `Ready to upload.` and exited 0 for any answer that was not a 401 or
  `cli_scope_required`, a 500, 502 or 429 included. It now says ready only on the answer that
  proves it, reports a server error or throttling with the status, and exits 1.
- A network failure in an agent command printed `fetch failed`. It now names the server and the
  cause, such as `connect ECONNREFUSED 127.0.0.1:8443`. The upload path names the cause too.
- Malformed `--args` printed the JSON parser's message. It now says that `--args` is not valid JSON
  and what it takes.
- `vinktar call` with no tool, and `vinktar sql` with no query, said `Not signed in` when run
  signed out. Arguments are checked first.
- A stream error other than `EPIPE` was rethrown from the handler and printed a stack trace. It
  prints one line and exits 1.

## 0.2.0

### Agents without MCP

Most coding agents reach Vinktar over MCP. Some can't — pi has no MCP on purpose, Aider and plain
CI jobs don't speak it — so the CLI now makes the same connection for them.

- `vinktar login` signs in in the browser with OAuth 2.1, PKCE and a loopback redirect: the same
  consent screen an editor shows, where you pick the workspace, optionally one project, and read or
  read and write. The client registers itself once and reuses the registration. The session is kept
  in `~/.config/vinktar/credentials.json` (mode 0600, written by rename), refreshed before it
  expires and once more on a 401, and `vinktar logout` revokes it.
- `vinktar tools` lists every tool with whether it writes; `vinktar call <tool> key=value …` runs
  one. Values are read as JSON when they parse, and `--args '{…}'` takes a whole object.
- Shortcuts for the calls people make by hand: `guide`, `keys`, `status`, `changes`, `sql`.
- `vinktar agents-md --write` puts the Vinktar block into `AGENTS.md` between its own markers,
  replacing only what is between them, so the next agent in the repository knows it's there.

There is no `ask`. Vinktar runs no model — the agent calling the CLI is the model, and it picks the
tool.

Every call counts, is rate limited and shows up on the project's AI agents page exactly as it would
from an editor. Still zero runtime dependencies.

## 0.1.0

First release.

### Bundler plugins

- Plugins for **Vite, Rollup, webpack, rspack and esbuild** over one shared core, each stamping at
  the last point that still owns the content hash — `renderChunk` (`order: 'post'`) for Rollup and
  Vite, `processAssets` just before `PROCESS_ASSETS_STAGE_OPTIMIZE_HASH` for webpack and rspack.
  Every one is covered by a real fixture build, including Vite 8's Rolldown pipeline.
- The Vite plugin exposes `import.meta.env.VINKTAR_KEY`, `VINKTAR_HOST`, `VINKTAR_ENVIRONMENT` and
  `VINKTAR_RELEASE` to the bundle, so the release the SDK reports is the one the maps went up
  under. The `cli` key is never exposed.
- Source maps are **deleted from the build output by default**, and the deletion runs even when no
  key is configured — an unset CI secret must not turn into a published copy of your source.
- `disable` returns a no-op plugin before any environment, git or network work, for a config shared
  with vitest or Storybook. `injectDebugIds: false` uploads without modifying a chunk, for builds
  under a strict CSP or with integrity computed elsewhere.

### Debug IDs

- Each chunk is stamped with an id derived from its own bytes and registered at runtime under the
  chunk's own stack signature, so a frame can be matched to its artifact even when the URL or the
  release string is wrong. The id is carried both as a `//# debugId=` comment and as a string
  literal inside the snippet, so it survives a minifier that strips comments.
- An id another tool already stamped — Rollup's `output.sourcemapDebugIds`, webpack 5.104's
  `debugIds`, esbuild, Rolldown — is adopted rather than replaced.
- The snippet goes at the top of the chunk, after any hashbang and directive prologue, so a chunk
  that throws while initialising still registers. The map is corrected exactly, by splicing one
  empty group into `mappings`, with no dependency. Under Rolldown it is appended instead, because
  the minifier there rebuilds the map after the plugin runs with no hook in between.

### Uploads

- Content-addressed pre-flight: the CLI asks which hashes ingest already holds and sends only the
  rest, so a redeploy of an unchanged build sends nothing.
- Batch size, per-file caps, concurrency and compression follow what the **server publishes**
  rather than numbers compiled in here. Parts are gzipped when the server accepts them.
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are honoured over a CONNECT tunnel, which Node's own
  `fetch` ignores.
- Uploaded `sources` are tidied — bundler URL prefixes stripped, absolute build paths made relative
  to the build root — in the uploaded copy only. Disable with `--no-rewrite-sources`.
- Retries on 429 (honouring `Retry-After`), 502, 503, 504, 507, 524 and transient network errors.

### CLI

- `sourcemaps upload`, `sourcemaps inject`, `sourcemaps resolve` and `doctor`.
- `resolve` decodes a position locally and prints the original line with context, so "would this
  frame resolve, and to what" can be answered without causing a real error in production.
- `doctor --dir` reports chunk/map id mismatches, maps missing `sourcesContent`, empty maps, ids
  nothing registers at runtime, and chunks stamped twice.
- Configuration by flag, environment or `.env`, in that order. A value that is blank after trimming
  is refused by name rather than treated as unset.

### Packaging

- ESM and CommonJS, so a CommonJS `webpack.config.js` can `require()` the plugin. `@vinktarhq/cli/vite`
  is ESM-only, since Vite configs are ESM and it loads Vite dynamically.
- Zero runtime dependencies. Node 18+.
