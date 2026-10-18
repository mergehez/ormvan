# Commands

Everything on this page runs in this repository, which is the workspace itself, rather than in an app.

```bash
bun install                   # link the workspace packages together
bun run build                 # build every package into its dist/
bun run typecheck             # tsc --noEmit, in every package
bun run test                  # the specs, against a scratch MySQL database
```

The root scripts run across the workspace. To reach one package, name it:

```bash
bun run --filter '@mergehez/ormvan' test
```

Each package's `test` loads the repository's `.env` for its connection, so the same database is used wherever it runs —
copy `.env.example` to `.env` once before running them. The adapter's tests also resolve `@mergehez/ormvan` to its
sources through a `development` export condition, so they run against the code you are editing and not a `dist/` that a
previous build left behind.

## Publishing to npm

`@mergehez/ormvan` and `@mergehez/ormvan-adonisjs` go to npm; `@mergehez/ormvan-nestjs` stays out until it has something of its own to add.

```bash
cd packages/core && npm publish       # the engine first: the adapter peers on it
cd packages/adonisjs && npm publish
```

Each package's `prepublishOnly` script builds its `dist/` — the runtime and the declarations — before the upload, so a
published tarball is never stale. Publish the engine first, and bump both versions together: the adapter peers on
`^<version>` of `@mergehez/ormvan`, so an engine release outside that range leaves an app unable to install the pair.
