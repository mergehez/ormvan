# Consuming it from an app

An app does not import these files by path. It depends on a package, and the package travels with the app as a
tarball:

```
"@mergehez/ormvan-adonisjs": "file:vendor/orm-adonisjs.tgz"     ← in an AdonisJS app's package.json
vendor/orm-adonisjs.tgz                                ← a packed tarball of the package
```

## Which package to depend on

The engine and the framework-specific pieces are separate packages:

| package            | depend on it when                                                                  |
| ------------------ | ---------------------------------------------------------------------------------- |
| `@mergehez/ormvan`     | the app uses no framework, or you only want the SQL engine and its models.          |
| `@mergehez/ormvan-adonisjs` | the app is an AdonisJS app. This re-exports the engine, so it is the one import.    |
| `@mergehez/ormvan-nestjs`   | the app is a NestJS app. It re-exports the engine and nothing else, for now.        |

An app that depends on an adapter does not also list `@mergehez/ormvan`: the adapter depends on it, and re-exports
everything the engine exports. So `import { Orm, PlainBaseModel } from '@mergehez/ormvan-adonisjs'` and
`import { Orm, PlainBaseModel } from '@mergehez/ormvan'` name the same classes.

## What is inside a tarball

A package ships its compiled runtime, the declarations that describe it, and the sources:

```
dist/*.js      the runtime — what an app loads
dist/*.d.ts    the declarations — what `exports.types` points at
src/*.ts       the sources — what the sourcemaps and the `development` export condition reference
```

Because the runtime is JavaScript, a server starts the app with plain node:

```bash
node bin/server.js
```

There is no TypeScript loader in the picture, so no runner has to be handed a loader flag
(`node --import @poppinss/ts-exec …`) to boot the app: `npm run start`, systemd, pm2 and a panel's own Node runner
all work. That matters most inside `node_modules`, where node refuses to strip types by itself.

Two properties the sources-only package had are kept:

- a package type error shows up in the app's typecheck rather than at runtime. The app's `tsc` reads the package through
  `exports.types`, which points at the declarations the engine shipped. An app that wants the check to run over the
  sources themselves sets `customConditions` to `["development"]` in its `tsconfig.json`; that is the condition
  `exports` uses for `src/*.ts`, and the same condition the adapter's tests pass to the runner, so a source-level error
  becomes the app's error rather than the engine's;
- `node ace build` compiles only the app's own code, and the app's runtime loads `dist/`.

`bun run build` writes each package's `dist/` and its declarations, so pack after building and a tarball is never
stale. In development an app's `postinstall` can replace the installed copy with a symlink into this repository — the
link resolves through the same `exports`, so `dist/` has to exist there too: `bun run watch` keeps it current while you
edit the engine.

## Why a tarball, and not `file:../orm`

- A deploy uploads the app's `build/` directory and installs the dependencies inside it, so the package has to travel
  inside that tarball. That is why each app lists `vendor/**` in its `adonisrc.ts` metaFiles.
- npm and bun copy a tarball dependency into `node_modules`, which keeps module resolution inside the app. The package
  then resolves `@adonisjs/core` to the app's own copy, and gets the app's running instance — its config, its paths —
  when it asks the framework for something. A `file:` link would resolve from this repository instead, and hand the
  adapter a second copy of the framework that was never booted.

## What an app keeps for itself

```
<app>/app/orm/project_orm.ts   ← the app's configuration, plus its model base class (`ModelBase`)
```

Everything else belongs to the package, so every import of it in an app is the package itself:

```ts
// in an app, anywhere
import { Game } from '#models/game';

const game = await Game.orm().where('id', id).first();
```

An AdonisJS app names one more thing: the request context. The engine's core declares that context empty, because it
never reads a member of it — it only forwards the value from `row.save(ctx)` to the `getAuthUser` callback. The
adapter fills it in with AdonisJS' `HttpContext`, so an app that imports the adapter gets the typed context in
`save(ctx)`:

```ts
// <app>/app/orm/project_orm.ts
import '@mergehez/ormvan-adonisjs'; // narrows `OrmContext` to AdonisJS' `HttpContext`
```

## What this repository holds

```
packages/core/        the engine — no framework imports, no app imports
packages/adonisjs/    the AdonisJS adapter (the migrate command, the session store, the VineJS rules)
packages/nestjs/      the NestJS adapter, empty for now
```

## Moving from the single-package layout

Before this repository was a monorepo, one package held everything, and an app imported `@app/orm`. The mapping is:

| old import                     | new import                                  |
| ------------------------------ | ------------------------------------------- |
| `@app/orm`                     | `@mergehez/ormvan` (or the adapter, which re-exports it) |
| `@app/orm/mysql2`              | `@mergehez/ormvan/mysql2`                       |
| `@app/orm/orm_migrations`      | `@mergehez/ormvan/orm_migrations`               |
| `@app/orm/orm_session`         | `@mergehez/ormvan-adonisjs/orm_session`              |
| `@app/orm/orm_vine`            | `@mergehez/ormvan-adonisjs/orm_vine`                 |
| `@app/orm/commands/orm_migrate`| `@mergehez/ormvan-adonisjs/commands/orm_migrate`     |
