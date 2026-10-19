# Migrations

A migration is a file that changes the database schema. Once it has run, it is also the record that the change
happened. The engine ships a migrator, and it is built on **knex**: knex owns the files, the batches, and the
`knex_migrations` table that says what has run. The DDL lives in those files rather than being derived from your
models, so there is no schema DSL to learn here.

`knex` is an optional peer of the engine: the migrator imports it when it runs, so an app that never migrates never
installs it.

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

A migration's name is its file name without the extension. That matters because the same migration exists twice while
you work on it — `0001_x.ts` in the sources and `0001_x.js` in a build — and recording the extension would make knex
treat the compiled file as a second, pending migration and run the schema again. The engine records `0001_x`, so
either file is the same migration.

## Running them yourself

`ormMigrator` is the migrator itself, with no framework in the way. Point it at a directory and a connection:

```ts
import { ormMigrator } from '@mergehez/ormvan/orm_migrations';

const migrator = await ormMigrator({
    connection: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'app' },
    directory: '/absolute/path/to/database/migrations',
});

await migrator.status(); // { applied: [...], pending: [...] }
await migrator.latest(); // { batch, ran } — everything pending, in one batch
await migrator.rollback(); // { batch, rolled } — the last batch, by each migration's `down`
await migrator.make('add_games'); // scaffolds a file, returns its path

await migrator.destroy(); // ends the connection knex opened
```

`connection` is passed to knex untouched, so any shape knex accepts works — including a pool or a socket.

## If you use an adapter

An adapter adds a command over the same migrator, so you do not have to wire it yourself. With
`@mergehez/ormvan-adonisjs`, `Orm.configure({ migrations })` says where to connect and what to run after, and the ACE
command exposes it:

```ts
// app/orm/project_orm.ts
Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName),
    migrations: {
        connection: connectionsConfig.mysql, // handed to knex as `connection`
        // directory: the app root's `database/migrations` is the default
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
// adonisrc.ts — registering the package's command
export default defineConfig({
    commands: [
        () => import('@adonisjs/core/commands'),
        () => import('@mergehez/ormvan-adonisjs/commands/orm_migrate'),
    ],
});
```

```bash
node ace orm:migrate              # run everything pending, in one batch
node ace orm:migrate --status     # what ran and what is waiting
node ace orm:migrate --rollback   # undo the last batch
node ace orm:migrate --make=x     # scaffold one
node ace orm:migrate --seed       # then run the seeder the app configured
```

Another adapter offers its own command or none at all; the migrator above is what it builds on.

## If the schema already exists

A first migration can adopt a schema that is already there instead of replaying it:

```ts
export async function up(knex: Knex): Promise<void> {
    if (await knex.schema.hasTable('users')) return; // adopt, do not recreate
}
```

An install that already has the tables then records the migration without running a statement, while a fresh database
gets the whole schema.

## Before you rely on rollback

Rollback is a convention rather than a guarantee, because MySQL commits DDL as it goes — a `down` cannot undo a
half-applied file.

## Running them from a build

A build compiles the app's migrations to `.js`, and `ormMigrator` loads `.ts`, `.js` and `.mjs` alike, so the same
migration works from a source checkout and from a compiled build. Whichever runner starts the app, no TypeScript
loader is involved.
