# Consuming it from an app

An app installs the engine from npm, like any other dependency:

```bash
npm install @mergehez/ormvan              # the engine on its own
npm install @mergehez/ormvan-adonisjs     # the engine plus the AdonisJS pieces
```

## Which package to depend on

The engine and the framework-specific pieces are separate packages:

| package            | depend on it when                                                                  |
| ------------------ | ---------------------------------------------------------------------------------- |
| `@mergehez/ormvan`     | the app uses no framework, or you only want the SQL engine and its models.          |
| `@mergehez/ormvan-adonisjs` | the app is an AdonisJS app. This re-exports the engine, so it is the one import.    |
| `@mergehez/ormvan-nestjs`   | the app is a NestJS app. It re-exports the engine and nothing else, for now.        |

An app that depends on an adapter does not also list `@mergehez/ormvan`: the adapter declares it as a peer dependency
and re-exports everything the engine exports, so npm and bun install it for you. That makes
`import { Orm, PlainBaseModel } from '@mergehez/ormvan-adonisjs'` and
`import { Orm, PlainBaseModel } from '@mergehez/ormvan'` name the same classes.

The engine itself names no framework, so an app with no adapter — or one for a framework that has no adapter yet — uses
`@mergehez/ormvan` directly and gets the same models, builders and migrations.

## What is inside the package

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

There is no TypeScript loader in the picture, so any runner works — `npm run start`, systemd, pm2, a container command.
That matters most inside `node_modules`, where node does not strip types.

The types are separate from the runtime. Your `tsc` reads the package through `exports.types`, which points at the
declarations the package shipped, so a type error in the engine shows up in your typecheck rather than at runtime.
If you would rather typecheck against the engine's own sources — so a source-level problem is reported as yours —
set `customConditions` to `["development"]` in your `tsconfig.json`. That is the condition `exports` uses for
`src/*.ts`. Most apps do not need it.

## Why a package, and not a path into a checkout

- A deploy uploads the app's `build/` directory and installs its dependencies there, so the dependency has to be
  something npm can resolve from the app's own `package.json`.
- npm and bun copy an installed dependency into the app's `node_modules`, which keeps module resolution inside the app.
  An adapter then resolves its framework to the app's own copy, and gets the app's running instance — its config, its
  paths — when it asks the framework for something. A `file:` link resolves from wherever the link points instead, and
  can hand the adapter a second copy of the framework that was never booted.

## What an app keeps for itself

An app writes one configuration module — where the database is, what the clock is, and who is acting:

```ts
// <app>/app/orm/project_orm.ts
import { Orm, PlainBaseModel } from '@mergehez/ormvan';

Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName),
    now: () => dt.unix(),
    getAuthUser: (ctx) => authUser(ctx),
});

export { Orm };
export class ModelBase extends PlainBaseModel {}
```

Everything else belongs to the package, so every import of it in an app is the package itself:

```ts
// in an app, anywhere
import { Game } from '#models/game';

const game = await Game.orm().where('id', id).first();
```

An AdonisJS app imports `@mergehez/ormvan-adonisjs` in that configuration file instead. Besides re-exporting the
engine, it narrows the request context: the engine's core declares that context empty, because it never reads a member
of it — it only forwards the value from `row.save(ctx)` to the `getAuthUser` callback. The adapter fills it in with
AdonisJS' `HttpContext`, so `save(ctx)` and `getAuthUser(ctx)` are typed against it.

## What this repository holds

```
packages/core/        the engine — no framework imports, no app imports
packages/adonisjs/    the AdonisJS adapter (the migrate command, the session store, the VineJS rules)
packages/nestjs/      the NestJS adapter, empty for now
```

## Working on the engine and an app at once

An app outside this repository installs the published packages, so to run it against the code you are editing, link
the packages into it. `bun link` registers a package from its own directory, then links it into the app by name:

```bash
# once, from each package you want to link
cd ../orm/packages/core && bun link
cd ../orm/packages/adonisjs && bun link

# then in the app
cd <app>
bun link @mergehez/ormvan @mergehez/ormvan-adonisjs
```

A link resolves through the same `exports`, so the package's `dist/` has to exist in this checkout too:
`bun run watch` keeps it current while you edit. To go back to the published packages, delete the symlinks and
reinstall:

```bash
rm -rf node_modules/@mergehez/ormvan node_modules/@mergehez/ormvan-adonisjs
bun install
```
