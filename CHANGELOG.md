# Changelog

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
