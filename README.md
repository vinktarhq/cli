# @vinktarhq/cli

[![npm](https://img.shields.io/npm/v/@vinktarhq/cli.svg)](https://www.npmjs.com/package/@vinktarhq/cli)
[![CI](https://github.com/vinktarhq/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/vinktarhq/cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@vinktarhq/cli.svg)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/@vinktarhq/cli.svg)](./LICENSE)

Makes your production stack traces resolve to the code you wrote instead of a minified bundle.

Add one plugin to your bundler. On every build it stamps each chunk with a debug id, uploads the
source maps to Vinktar, and deletes them from the output so they are never served to users.

```ts
// vite.config.ts
import { vinktar } from '@vinktarhq/cli/vite';

export default defineConfig({ plugins: [vinktar()] });
```

```bash
export VINKTAR_CLI_KEY=vnk_sk_…   # a key with the "cli" scope
npm run build
```

That is the whole setup. Rollup, webpack, rspack and esbuild have the same plugin, and there is a
CLI for pipelines that build in one place and upload from another.

**Node 18+. Zero runtime dependencies** — `npx` downloads the whole manifest before it runs a
line, so every dependency would be latency on every CI run.

---

## Contents

- [Getting a key](#getting-a-key)
- [Bundler plugins](#bundler-plugins)
- [Plugin options](#plugin-options)
- [The CLI](#the-cli)
- [Environment variables](#environment-variables)
- [Stack traces still minified?](#stack-traces-still-minified)
- [How it works](#how-it-works)
- [Compatibility](#compatibility)

---

## Getting a key

Source-map upload needs a key with the **`cli` scope**. A write key is not enough — create one in
your project settings. Secret keys start `vnk_sk_`; publishable ones start `vnk_pk_` and are the
kind that belongs in a browser bundle.

```bash
export VINKTAR_CLI_KEY=vnk_sk_…
npx @vinktarhq/cli doctor
```

```
host  https://in.vinktar.com
key   vnk_sk_Unyv…OP1m

reachable          yes
key accepted       yes
upload scope       yes

Ready to upload.
```

`VINKTAR_CLI_KEY` is read before `VINKTAR_KEY`. They are separate on purpose: a CI job usually
already exports `VINKTAR_KEY` for the browser bundle, and that one is the *public* write key,
which this endpoint refuses.

**Never put a `cli` key in a bundle.** It is a build credential, not a runtime one.

---

## Bundler plugins

Every plugin does the same two things — stamp each chunk as it is generated, upload the maps after
the build — and takes the same [options](#plugin-options).

### Vite

```ts
// vite.config.ts
import { vinktar } from '@vinktarhq/cli/vite';

export default defineConfig({
  plugins: [vinktar()],
});
```

Vite gets a little extra. The plugin also exposes `import.meta.env.VINKTAR_KEY`, `VINKTAR_HOST`,
`VINKTAR_ENVIRONMENT` and `VINKTAR_RELEASE` to your bundle, so

```ts
init({ key: import.meta.env.VINKTAR_KEY, release: import.meta.env.VINKTAR_RELEASE });
```

is the whole application-side setup, and the release the SDK reports is guaranteed to be the one
the maps were uploaded under. `VINKTAR_CLI_KEY` is never exposed — a bundle is public.

It also turns on `build.sourcemap: 'hidden'` for you, which is what you want: the maps are
generated for the upload and no `sourceMappingURL` comment points at them.

Works on Vite 5 and newer; CI builds real fixtures against 7.3 and 8.2, the latter being the
Rolldown/Oxc pipeline, where the minifier runs after the plugin and strips comments.

### Rollup

```js
// rollup.config.mjs
import { vinktarRollup } from '@vinktarhq/cli/rollup';

export default { plugins: [vinktarRollup({ urlPrefix: '/assets/' })] };
```

### webpack and rspack

```js
// webpack.config.js — CommonJS, which is what webpack configs usually are
const { vinktarWebpack } = require('@vinktarhq/cli/webpack');

module.exports = {
  devtool: 'hidden-source-map',
  plugins: [new vinktarWebpack({ urlPrefix: '/static/' })],
};
```

```js
// rspack.config.js
const { vinktarRspack } = require('@vinktarhq/cli/rspack');

module.exports = { plugins: [new vinktarRspack()] };
```

`import` works too. Every entry point except `@vinktarhq/cli/vite` ships both ESM and CommonJS —
see [Compatibility](#compatibility).

### esbuild

```js
import { vinktarEsbuild } from '@vinktarhq/cli/esbuild';

await esbuild.build({
  plugins: [vinktarEsbuild()],
  sourcemap: true,
  metafile: true, // required — it is how the plugin finds the output
});
```

**One honest caveat.** esbuild has no hook between generating a chunk and writing it, so this
plugin edits the files afterwards. If your build puts `[hash]` in `entryNames` or `chunkNames`,
that hash is computed before the debug id exists and will not match the file on disk — the plugin
warns once when it sees this. Nothing in esbuild's API avoids it today. Vite, Rollup, webpack and
rspack all have a hook that runs before hashing, so they have neither problem.

---

## Plugin options

```ts
vinktar({
  urlPrefix: '/assets/',
  deleteSourcemapsAfterUpload: true,
  errorHandler: (error) => { throw error; },
});
```

| Option | Default | |
|---|---|---|
| `urlPrefix` | Vite's `base`, else `~/` | What the files are served under, for release+url matching |
| `release` | CI commit, then the full git SHA | Must match what your SDK reports |
| `dist` | — | Build discriminator, when several builds share one release |
| `key` | `$VINKTAR_CLI_KEY` | The `cli`-scoped key |
| `host` | `$VINKTAR_HOST`, else `https://in.vinktar.com` | Ingest host |
| `uploadSourcemaps` | `true` | `false` turns the whole feature off, deletion included |
| `deleteSourcemapsAfterUpload` | `true` | Remove the maps from the build output afterwards |
| `injectDebugIds` | `true` | `false` uploads without modifying any chunk, for strict CSP/SRI builds |
| `disable` | `false` | Return a no-op plugin before any env, git or network work |
| `errorHandler` | — | Called instead of failing. Throw from it to fail the build |
| `silent` | `false` | Suppress the plugin's own output. Warnings are never silenced |

### Two defaults worth knowing about

**Maps are deleted from your build output.** A source map is your original source; the bundler only
emitted one because this plugin asked it to, so leaving it in a public directory publishes your
whole codebase to anyone who guesses `app.js.map`. Set `deleteSourcemapsAfterUpload: false` if you
mean to serve them.

**A missing key warns, it does not fail.** A contributor running `npm run build` with no key gets a
loud warning naming the consequence — and the maps are still deleted, because "the CI secret was
never wired up" must not become "we shipped our source". If the upload is *attempted* and fails
while deletion is on, that **does** fail the build: there is no second chance once the maps are
gone. Pass an `errorHandler` to opt back into warn-only.

---

## The CLI

For pipelines that build on one machine and upload from another, or where you would rather not add
a plugin.

```bash
npx @vinktarhq/cli sourcemaps upload ./dist --release "$GIT_SHA"
```

| Command | |
|---|---|
| `sourcemaps upload <dir>` | Stamp every chunk, then send the maps. Run after your bundler |
| `sourcemaps inject <dir>` | Only the stamping, for a machine that will not do the upload |
| `sourcemaps resolve <map> --line <n> --column <n>` | Decode one position locally and print the original line |
| `doctor [--dir <dir>]` | Check the key, its scope, the host — and with `--dir`, the build |

<details>
<summary><strong>All flags</strong></summary>

Precedence is flag → environment → `.env` file → default. Every value is trimmed, and one that is
blank after trimming is refused *by name* rather than treated as unset: `--release "$TAG"` with an
unset `TAG` is a release named nothing, not no release.

| Flag | |
|---|---|
| `--key` | A `cli`-scoped key. Defaults to `$VINKTAR_CLI_KEY`, then `$VINKTAR_KEY` |
| `--release` | Defaults to the CI commit, then the full git SHA |
| `--dist` | Build discriminator |
| `--host` | Ingest host |
| `--url-prefix` | `/assets/`, `https://cdn.example.com/`, or `~/` (default) |
| `--ignore <glob>` | Skip matching chunks entirely. Repeatable |
| `--ext <list>` | Extensions to treat as chunks. Default `js,cjs,mjs` |
| `--no-inject` | Upload without stamping. Those chunks match by release + url only |
| `--no-rewrite-sources` | Send `sources` exactly as the bundler wrote them |
| `--dry-run` | Print what would be uploaded. Sends nothing, needs no key |
| `--strict` | Treat any warning as a failure (exit 2) |
| `--allow-failure` | Never exit non-zero because the upload failed |
| `--concurrency` `--timeout` `--retries` | Request shaping |
| `--header 'Name: value'` | For a gateway in front of ingest. Repeatable |
| `--dotenv-file <path>` | Read `VINKTAR_*` from a file. Ranks below the real environment |
| `--quiet` `--debug` | How much it says. `--debug` redacts the key |

Exit codes: `0` fine, `1` it did not work, `2` it worked and `--strict` found something anyway.

</details>

### In a deploy

```bash
npm run build
npx @vinktarhq/cli sourcemaps upload ./dist --release "$GITHUB_SHA"
```

`--release` must match what your SDK reports. If they differ the upload succeeds and never matches
a single frame — which is why the Vite plugin defines the release into your bundle for you.

---

## Environment variables

| | |
|---|---|
| `VINKTAR_CLI_KEY` | The `cli`-scoped key. **Build-time only, never in a bundle** |
| `VINKTAR_RELEASE` | Overrides detection. Must match what the SDK reports |
| `VINKTAR_HOST` | Ingest host, for self-hosted deployments |
| `VINKTAR_DIST` | Build discriminator |
| `VINKTAR_IGNORE` | Comma-separated globs |
| `VINKTAR_DISABLE` | `1` turns the plugin into a no-op |
| `VINKTAR_UPLOAD_CONCURRENCY`, `VINKTAR_HTTP_TIMEOUT`, `VINKTAR_HTTP_MAX_RETRIES` | Request shaping |
| `VINKTAR_QUIET`, `VINKTAR_DEBUG`, `VINKTAR_LOG_LEVEL` | Output |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Honoured over a CONNECT tunnel — Node's own `fetch` ignores these, so without it a corporate network gives you `ECONNREFUSED` from a tool that works everywhere else |

**Using Turborepo?** Add `VINKTAR_*` to the build task's `passThroughEnv`, or the key never reaches
the build. The plugin warns when it detects this.

---

## Stack traces still minified?

Every failure here looks identical from the outside, which is why these tools exist:

```bash
npx @vinktarhq/cli doctor --dir ./dist
```

It separates *wrong key*, *right key wrong scope*, *wrong host*, *the build was never stamped*, and
*fine, your maps just have not uploaded yet*. With `--dir` it also reports maps missing
`sourcesContent`, inline maps, empty maps, chunks stamped twice (your output directory was not
cleaned), and the one genuinely fatal state — a chunk whose debug id differs from its map's, which
can never resolve.

Then check a specific frame without causing a real error:

```bash
npx @vinktarhq/cli sourcemaps resolve ./dist/assets/app-DfK29aQx.js.map --line 1 --column 4821
```

```
debug id  b2b1f8b1-0f3e-4a51-9a1e-7c0d9b2e1f44
src/App.tsx:42:11  (handleSubmit)

     40 |   const handleSubmit = async () => {
     41 |     const body = serialise(form);
>    42 |     await post('/api/orders', body);
     43 |   };
```

The usual causes, in order:

1. **The release does not match.** The SDK reports one string and the maps went up under another.
   The Vite plugin removes this class of bug entirely.
2. **Source maps are off.** The CLI says so loudly — "found N JavaScript files and no source maps".
3. **No `cli` scope.** The error is `cli_scope_required`, which reads like a bad key and isn't.
4. **The upload never ran.** No key in CI is the common one; the warning names it.

---

## How it works

**Debug IDs.** Each chunk gets an id derived from its own bytes, written into both the chunk and
its map. A tiny snippet at the top of the chunk registers that id at runtime under the chunk's own
stack signature, so when an error is captured the SDK can report exactly which artifact each frame
came from. That survives a CDN rewriting paths, a bundle served from two origins, or a release
string being wrong — none of which release-plus-URL matching survives.

The id is derived from the chunk's content, so rebuilding unchanged source produces the same id and
re-uploading is free.

**Nothing is uploaded twice.** Before sending anything the CLI asks ingest which content hashes it
already holds. A redeploy of an unchanged build sends nothing at all.

**Limits come from the server**, not from a number compiled in here, so batch size, per-file caps
and compression follow what your deployment actually accepts. Parts are gzipped when the server
says it accepts them.

**Uploaded `sources` are tidied** — `webpack:///` prefixes stripped, absolute build-machine paths
made relative to the build root — in the uploaded copy only. The file on disk is never touched.
Disable with `--no-rewrite-sources`.

---

## Compatibility

| | Supported | Built against in CI |
|---|---|---|
| Node | 18 and newer | 18, 20, 22, 24 |
| Vite | >=5 | 7.3 and 8.2 (Rolldown) |
| Rollup | >=3 | 4.63 |
| webpack | >=5 | 5.110 |
| rspack | >=1 | 1.7 |
| esbuild | >=0.19 | 0.28 |

Every bundler is an **optional** peer dependency — install only the one you use, and npm will tell
you if its version is outside the range above.

**Module systems.** Everything ships as both ESM and CommonJS, so a `webpack.config.js` using
`require()` works, and so does an ESM config. The one exception is `@vinktarhq/cli/vite`, which is
ESM-only: Vite configs are ESM and the plugin loads Vite itself dynamically, which CommonJS cannot
do. TypeScript types ship for both, under `moduleResolution` `node16`, `nodenext` or `bundler`.

The Vite, webpack and rspack fixture builds need Node 20.19+, so they run on a narrower matrix than
the package's own floor — a fixture's requirement is not the package's.

---

## Programmatic use

```js
import { inject, upload, resolvePosition, doctor } from '@vinktarhq/cli';

await inject('./dist', console.log);
await upload('./dist', { host, key, release, urlPrefix: '~/', dryRun: false }, console.log);

const { position } = await resolvePosition('./dist/app.js.map', 1, 4821);
```

---

## Licence

MIT. © Vinktar.
