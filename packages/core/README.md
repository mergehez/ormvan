# @mergehez/ormvan

An ORM for people who want to write their own SQL. You write the query in TypeScript, the engine builds the SQL string
and runs it over `mysql2`, and a model is a class that says which table it uses and which columns it has. The type of
every row you get back comes from that class, so there is no schema file to keep in step and no code generation.

This package is the engine alone. It knows nothing about any framework; an app that uses one depends on that framework's
adapter instead, which re-exports everything here.

## Install

```bash
npm install @mergehez/ormvan mysql2
```

`knex` is an optional peer: the engine never loads it, and only the migration command needs it, so install it when you
drive migrations from the engine.

## Configure the engine, once per app

The engine has no connection, no clock and no idea who is logged in, so it asks the app for all three. Call
`Orm.configure` once while the app boots, and every query after that reads that configuration:

```ts
// <app>/app/orm/project_orm.ts
import { Orm, PlainBaseModel } from '@mergehez/ormvan';

Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName), // how to reach MySQL
    now: () => dt.unix(), // the clock behind `updated_at` stamping
    getAuthUser: (ctx) => authUser(ctx), // who is acting, behind `updated_by` stamping
});

export { Orm };
export class ModelBase extends PlainBaseModel {}
```

## Declare a model, then read it

A model names its table, its columns and its relations. The engine reads those declarations to work out the type of your
rows, and to know which columns it is allowed to write:

```ts
import { column, belongsTo, hasMany } from '@mergehez/ormvan';
import type { BelongsTo, HasMany } from '@mergehez/ormvan';

export class Game extends ModelBase {
    @column({ isPrimary: true }) declare id: number;
    @column() declare title: string;
    @column() declare status: number;

    @belongsTo(() => User, { foreignKey: 'created_by' })
    declare creator: BelongsTo<typeof User>;

    @hasMany(() => Entry, { foreignKey: 'game_id' })
    declare entries: HasMany<typeof Entry>;
}

const games = await Game.orm().where('status', 1).orderBy('id', 'desc').limit(10).get();

games[0].title; // typed, because the model declares `title`
```

## What else is in it

- Builders for a main query, a preload, a `whereHas` and a count, each offering only the clauses it can compile.
- Hooks that run your code before or after a read or a write.
- Soft delete, which marks a row instead of removing it.
- Migrations, driven by knex through the engine's own migrate command.
- Relations, pagination, hidden columns and typed serialization.

## Documentation

The full documentation lives in the repository:

- [Getting started](https://github.com/mergehez/ormvan/blob/main/docs/index.md)
- [Configuration](https://github.com/mergehez/ormvan/blob/main/docs/configuration.md)
- [Writing](https://github.com/mergehez/ormvan/blob/main/docs/writing.md)
- [Joins and unions](https://github.com/mergehez/ormvan/blob/main/docs/joins-and-unions.md)
- [Hooks](https://github.com/mergehez/ormvan/blob/main/docs/hooks.md)
- [Soft delete](https://github.com/mergehez/ormvan/blob/main/docs/soft-delete.md)
- [Migrations](https://github.com/mergehez/ormvan/blob/main/docs/migrations.md)

## License

MIT
