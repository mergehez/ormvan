# Migrations

A migration is a file that changes the database schema. Once it has run, it is also the record that the change
happened. The engine ships a command that runs them, and that command is built on **knex**: knex owns the files, the
batches, and the `knex_migrations` table that says what has run. The DDL lives in those files rather than being derived
from your models, so there is no schema DSL to learn here.

## Running them

```bash
node ace orm:migrate              # run everything pending, in one batch
node ace orm:migrate --status     # what ran and what is waiting
node ace orm:migrate --rollback   # undo the last batch (each migration's `down`)
node ace orm:migrate --make=x     # scaffold one
node ace orm:migrate --seed       # then run the seeder the app configured
```

## Writing one

A migration is a module exporting `up(knex)` and `down(knex)`. Whatever `up` does is what the database gets:

```ts
export async function up(knex: Knex): Promise<void> {
    if (await knex.schema.hasTable('games')) return; // already there: adopt it, do not replay

    await knex.schema.createTable('games', (table) => {
        table.increments('id');
        table.string('title');
        table.integer('status').defaultTo(0);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('games');
}
```

## Wiring it into an app

An app says where to connect and registers the command. The app's own `commands/` directory is scanned; a command that
comes from a package is named in `adonisrc.ts`:

```ts
// app/orm/project_orm.ts
import { Orm } from '@mergehez/ormvan';

Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName),
    migrations: {
        connection: connectionsConfig.mysql, // handed to knex as `connection`
        seed: async () => {
            const { default: seed } = await import('#database/seeders/DatabaseSeeder'); // what --seed runs
            await seed();
        },
        after: async () => {
            // Runs after the app's migrations, before the seed — for tables another package owns.
        },
    },
});
```

```ts
// adonisrc.ts
commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@mergehez/ormvan-adonisjs/commands/orm_migrate'),
],
```

## Two details the engine settles for you

- A migration's name is its file name without the extension. knex records the extension, which would make `0001_x.ts`
  and `0001_x.js` two different migrations, so a database migrated from sources would see the compiled file as pending
  and run the whole of it a second time. The engine records `0001_x`, and it renames records that an earlier setup
  wrote with an extension, so moving between sources and a build does not replay your history.
- A schema that already exists is adopted rather than replayed. A ported app's first migration guards on the schema
  (`if (await knex.schema.hasTable('users')) return;`), so an install that already has the tables records the migration
  without running a statement, while a fresh database gets the whole schema.

## Before you rely on rollback

`knex` is an optional peer: the command imports it when it runs, so an app that never migrates never installs it.
Rollback is a convention rather than a guarantee, because MySQL commits DDL as it goes — a `down` cannot undo a
half-applied file. If your app would rather have its own command, the same primitives are exported from
`@mergehez/ormvan/orm_migrations` (`ormMigrator`).

## Running them from a build

Every package ships compiled JavaScript in its tarball, so the command works with plain node wherever the package sits —
a `node ace build` output on a server included:

```bash
node ace.js orm:migrate
```

(An install of the engine older than that — sources only — needed `node --import @poppinss/ts-exec ace.js orm:migrate`,
because node refuses to strip types for files inside `node_modules`.)
