# orm — a raw-SQL ORM engine, with an adapter per framework

This repository holds `@mergehez/ormvan`, an ORM for people who want to write their own SQL, and one package per framework
that speaks to it. You write the query in TypeScript, the engine builds the SQL string and runs it over `mysql2`, and a
model is a class that says which table it uses and which columns it has. The type of every row you get back comes from
that class. There is no schema file to keep in step and no code generation: each package's `build` produces the `dist/`
an app loads.

## The packages

| package            | what it holds                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `@mergehez/ormvan`     | the engine, and nothing about any framework: models, builders, hooks, soft delete, migrations, and `mysql2`. |
| `@mergehez/ormvan-adonisjs` | what an AdonisJS app needs: the ACE `orm:migrate` command, the `database` session store, the VineJS rules.   |
| `@mergehez/ormvan-nestjs`   | the NestJS adapter. Empty for now: it re-exports the engine until NestJS-specific wiring lands.              |

An app that uses no framework depends on `@mergehez/ormvan` alone. An app that uses AdonisJS depends on
`@mergehez/ormvan-adonisjs`, which re-exports the engine and adds what AdonisJS asks for. Nothing under `@mergehez/ormvan` names a
framework, so a framework the engine has not met yet — NestJS, or one of your own — is a package like the others.

## Where to start

Start at [`docs/index.md`](./docs/index.md), or jump straight to the page you need:

- [Consuming it from an app](./docs/consuming.md) — installing the package, and what it carries
- [Configuration](./docs/configuration.md) — `Orm.configure`, models, and your own query methods
- [Writing](./docs/writing.md) — insert, update, delete, bulk writes, and values that are SQL expressions
- [Joins and unions](./docs/joins-and-unions.md) — how a join adds typed columns, and where you can write one
- [Hooks](./docs/hooks.md) — running your code before or after a read or a write
- [Soft delete](./docs/soft-delete.md) — deletes that mark a row instead of removing it
- [Migrations](./docs/migrations.md) — creating and changing the schema
- [Commands](./docs/commands.md) — build, typecheck, test, and publishing
- [Deliberate omissions](./docs/not-done.md) — what the engine does not do

## Commands

```bash
bun install                   # link the workspace packages together
bun run build                 # build every package into its dist/
bun run typecheck             # tsc --noEmit, in every package
bun run test                  # the engine's specs, against a scratch MySQL database
```

Each command runs across the workspace; the same names work in a single package (`bun run --filter '@mergehez/ormvan'
test`), and a package's `test` loads the repository's `.env` for its database connection — copy `.env.example` to
`.env` once before running them.
