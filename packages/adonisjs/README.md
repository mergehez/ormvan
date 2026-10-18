# @mergehez/ormvan-adonisjs

The AdonisJS adapter for [`@mergehez/ormvan`](https://www.npmjs.com/package/@mergehez/ormvan). It re-exports the whole engine,
so an AdonisJS app imports this package and never `@mergehez/ormvan` directly, and it adds the few pieces that speak
AdonisJS' contracts.

## Install

```bash
npm install @mergehez/ormvan-adonisjs
```

This pulls in `@mergehez/ormvan` for you. `@adonisjs/session` and `@vinejs/vine` are optional peers: install them only when
you use the store or the rules.

## What it adds

- `@mergehez/ormvan-adonisjs` — the engine's public surface, re-exported, with the engine's request context narrowed to AdonisJS'
  `HttpContext`. Importing this module is what makes `save(ctx)` and `getAuthUser(ctx)` speak `HttpContext`.
- `@mergehez/ormvan-adonisjs/orm_session` — the `database` session store.
- `@mergehez/ormvan-adonisjs/orm_vine` — the VineJS `exists` and `unique` rules.
- `@mergehez/ormvan-adonisjs/commands/orm_migrate` — the ACE `orm:migrate` command.

## Use

```ts
// <app>/app/orm/project_orm.ts
import { Orm, PlainBaseModel } from '@mergehez/ormvan-adonisjs';

Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName),
    now: () => dt.unix(),
    getAuthUser: (ctx) => authUser(ctx), // `ctx` is AdonisJS' HttpContext
});

export { Orm };
export class ModelBase extends PlainBaseModel {}
```

Declare the migrate command in `adonisrc.ts`:

```ts
// adonisrc.ts
export default defineConfig({
    commands: [
        () => import('@adonisjs/core/commands'),
        () => import('@mergehez/ormvan-adonisjs/commands/orm_migrate'),
    ],
});
```

## Documentation

- [Consuming it from an app](https://github.com/mergehez/ormvan/blob/main/docs/consuming.md)
- [Migrations](https://github.com/mergehez/ormvan/blob/main/docs/migrations.md)
- [Commands](https://github.com/mergehez/ormvan/blob/main/docs/commands.md)
- [The engine's own documentation](https://github.com/mergehez/ormvan/blob/main/docs/index.md)

## License

MIT
