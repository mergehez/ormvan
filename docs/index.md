# orm — the shared ORM engine

`orm` is an ORM for people who want to write their own SQL. You write the query in TypeScript, the engine builds the
SQL string and runs it over `mysql2`, and a model is a class that says which table it uses and which columns it has.
The type of every row you get back comes from that class. There is no schema file to keep in step and no code
generation; the engine's own `bun run build` produces the `dist/` an app loads.

The engine is split into a framework-agnostic core package plus one adapter package per framework, so a fix lands once
and every app that depends on it gets it. The framework-free core is what the rest of these pages describe; an adapter
adds the few things a specific framework asks for (see [Consuming it from an app](./consuming.md)).

## The words this documentation uses

If one of these words is new to you, this is what it means on the following pages.

| word              | meaning                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **engine**        | this package, `@mergehez/ormvan`. It knows SQL, and nothing about your app or a framework.                                                                                  |
| **adapter**       | an optional package that adds what one framework asks for, such as `@mergehez/ormvan-adonisjs`. It re-exports the engine, so an app that uses it imports the adapter alone. |
| **app**, **host** | an application that depends on the engine.                                                                                                                               |
| **configuration** | one file per app, `app/orm/project_orm.ts`, where the app says how to reach the database, what its clock is, and who is logged in.                                       |
| **model**         | a class naming a table, its columns, its hidden columns and its relations.                                                                                               |
| **builder**       | what `Model.orm()` returns. You add clauses to it and then call `get()`, `first()`, `updateAll()`, and so on.                                                            |
| **plain row**     | what a read returns: the data, and nothing else.                                                                                                                         |
| **mutable row**   | a row that also has `save()` and `refresh()` on it. The reads that hand you one say so in their name, like `firstMutable()`.                                             |
| **flavour**       | one shape of query: a main query, a preload callback, a `whereHas`, a count. Each one has its own builder, which offers only the clauses it can compile into that shape. |
| **hook**          | a method on a model that the engine calls before or after a read or a write.                                                                                             |

## Where to go

If this is your first time here, read them in this order.

1. [Consuming it from an app](./consuming.md) — how an app installs the engine, and what a package carries.
2. [Configuration](./configuration.md) — `Orm.configure`, your own query methods, and what stays in the app.
3. [Writing](./writing.md) — insert, update, delete, bulk writes, and values that are SQL expressions.
4. [Joins and unions](./joins-and-unions.md) — how a join adds typed columns, and where you can write one.
5. [Hooks](./hooks.md) — running your code before or after a read or a write.
6. [Soft delete](./soft-delete.md) — deletes that mark a row instead of removing it.
7. [Migrations](./migrations.md) — creating and changing the schema.
8. [Deliberate omissions](./not-done.md) — what the engine does not do.

The commands used to build and publish the packages themselves live in the repository's
[README](https://github.com/mergehez/ormvan#commands).
