# Contributing

Thanks for looking. Bug reports are especially welcome for this package, because almost every way
it can fail looks the same from the outside — stack traces stay minified — so a report with your
bundler, its version, and the output of `npx @vinktarhq/cli doctor --dir <your build>` is worth a
great deal.

## Getting set up

```bash
npm install
npm run typecheck
npm test
```

`npm test` is the fast suite: unit tests, a local HTTP server, and the two bundlers that still run
on Node 18. It should take a few seconds.

```bash
npm run test:bundlers
```

That one builds real projects through Vite, webpack and rspack. It is separate because those need
**Node 20.19 or newer**, and the package itself supports Node 18 — a fixture's requirement must not
become the package's.

## What the tests are for

The fixture builds are the point. A bundler plugin that compiles is not a bundler plugin that
works: the failures in this area are hook ordering, asset-API details and sourcemap composition,
and none of them show up in a unit test. If you change anything under `src/bundler/` or `src/vite.ts`,
there should be a fixture build that would have caught it.

There is also a CI job that packs the tarball, installs it somewhere else and uses it. `npm test`
imports from `src/`, so it can pass while the published package is unusable — a missing `require`
condition, a `files` list that ships no `dist`, a lost shebang. Only installing the real thing
catches those.

## House style

- **Zero runtime dependencies.** A test asserts it. `npx` downloads the whole manifest before it
  runs a line, so every dependency is latency on every CI run.
- **Nothing fails silently.** Every skip is a warning that names the consequence. If a build ends
  up with no symbolication, the output has to say so and say why.
- Comments explain *why*, not *what*, and are worth writing where a rule looks arbitrary — most of
  them here record a specific failure that a future simplification would reintroduce.

## Releasing

Maintainers only. Publishing runs from CI, because `publishConfig.provenance` requires an OIDC
token that only a workflow can supply:

1. Bump `version` in `package.json` and move the changelog heading.
2. Create a GitHub release tagged `v<version>`.

The workflow refuses to run if the tag disagrees with `package.json`, builds, runs both suites,
publishes, and then installs the published version from the registry to prove it works.
