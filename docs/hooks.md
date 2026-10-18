# Hooks

## What a hook is

A hook is a method on your model that the engine calls around a read or a write. Hooks are how you keep a rule in one
place instead of repeating it at every call site: stamping `updated_at`, hiding archived rows, stopping a delete, or
dropping a cache entry.

You declare the ones you need in a static `hooks` property:

```ts
import type { OrmHooks } from '@mergehez/ormvan';

export class Game extends ModelBase {
    static hooks: OrmHooks<typeof Game> = {
        beforeInsert: (row, { now }) => {
            row.created_at ??= now();
        },
        beforeUpdate: (row, { now }) => {
            row.updated_at = now();
        },
        beforeRead: (q, { phase }) => {
            if (phase !== 'count') q.whereNull('archived_at');
        },
        afterRead: (rows) => rows.map((row) => ({ ...row, ends_at: Game.endsAt(row) })),
        beforeDelete: async (game, { client }) => {
            // A locked game is kept, but marked retired first.
            if (!game.locked) return;
            await Game.orm(client).where('id', game.id).updateAll({ retired_at: Date.now() });
            return false;
        },
    };
}
```

A subclass inherits them: the engine runs the base model's hooks first, and then each subclass's own.

## The ten hooks

Every one of them is optional, so a model declares as few as it needs. These are all ten:

| hook            | when the engine calls it          | what your hook gets and can do                                                                              |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `beforeRead`    | before the SQL of a read is built | the builder and `ctx.phase`. Add clauses: `q.where('status', 1)`.                                           |
| `afterRead`     | after the rows come back          | the rows. Change them in place, or return the array to use instead.                                         |
| `beforeInsert`  | before `Orm.create()` inserts     | the row that will be inserted. Change it in place, or return `{ done: row }` if you inserted it yourself.   |
| `afterInsert`   | after the row exists              | the row as it is now. Runs even when `beforeInsert` returned `{ done }`, unless that hook asked to skip it. |
| `beforeUpdate`  | before an update is written       | the columns about to be written. Change them in place, or return `{ done }`.                                |
| `afterUpdate`   | after the update is written       | the row as it is now. Same rule as `afterInsert` on the mutable path.                                       |
| `beforeDelete`  | before a row is deleted           | the row. Return `false` to keep it.                                                                         |
| `afterDelete`   | after the row is gone             | the row that was deleted. `ctx.softDelete` says whether it was marked instead.                              |
| `beforeRestore` | before a restore is written       | the query that is about to un-mark rows. Narrow it, or throw to refuse.                                     |
| `afterRestore`  | after a restore is written        | the rows that came back.                                                                                    |

## What every hook receives

Your hook gets its row or builder first, and a context object second. Every path has its own context type, so a hook
only sees what its path can tell it: a read hook's context carries `phase`, an update hook's `original`, a delete
hook's `softDelete` and `deletedBy`, and an insert hook's the shared fields alone.

| field                        | what it is                                                                                         | how you use it                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `client`                     | the transaction the statement runs in, or `undefined` when the caller opened none.                 | `await Game.orm(client).insert(...)` — same transaction |
| `now()`                      | your app's clock, the one in `Orm.configure({ now })`.                                             | `row.updated_at = now()`                                |
| `isFirstCall` / `isLastCall` | where this call sits in the statement's calls to this hook. A delete calls its hooks once per row. | `if (ctx.isLastCall) await Cache.forgetEntryRelated()`  |
| `withoutHooks`               | the hook names this statement asked to skip.                                                       | rarely needed — see the rules at the end                |

What a hook _path_ adds:

| field        | context                | what it is                                                                                            | how you use it                                                          |
| ------------ | ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `phase`      | `OrmReadHookContext`   | which read called the hook: `get`, `first`, `paginate`, `count`, `countDistinct` or `exists`.         | `if (phase === 'count') return`                                         |
| `original`   | `OrmUpdateHookContext` | the row as it was read. Absent on a bulk `updateAll`, which has no row to compare against.            | `if (row.status !== original.status) row.changed_at = now()`            |
| `softDelete` | `OrmDeleteHookContext` | whether this delete MARKS the row (`deleted_at`) instead of removing it.                              | `if (!ctx.softDelete) return` — nothing to cascade to                   |
| `deletedBy`  | `OrmDeleteHookContext` | the actor this delete is attributed to — what is written into `deleted_by`. `null` for a hard delete. | pass it on: `.delete(ctx.deletedBy)`; add `extra` columns for the _why_ |

### Doing work once per statement

A delete calls `afterDelete` once per row, so a cache drop in there would run 100 times for 100 rows. `ctx.isLastCall`
marks the last of those calls:

```ts
afterDelete: async (_row, ctx) => {
    if (!ctx.isLastCall) return;

    await Cache.forgetEntryRelated(); // once per delete, after the last row went
},
```

`isFirstCall` and `isLastCall` describe this hook's calls for one statement — they are named after the call, so they
say nothing about a `first()`/`last()` chain method. A statement that calls the hook once — a read, `Orm.create()`,
`save()` on one row, `updateAll()`, or a delete of a single row — has both of them set to `true`.

## Which calls run them

- `Orm.create(Model, payload)` runs `beforeInsert`, then the INSERT, then `afterInsert`. It reads the new row back from
  the database, and that read runs your read hooks as well, with `phase: 'first'`.
- `row.save()` and `Orm.update(Model, pk, data)` run `beforeUpdate`, then the UPDATE, then `afterUpdate`.
- `updateAll(payload)` runs `beforeUpdate` once for the whole statement. It never runs `afterUpdate`, because one
  statement is not one row.
- `delete(actor, extra?)` and `deleteBy(pk, actor, extra?)` run `beforeDelete` and `afterDelete` once per row, and only
  when the model declares one of them. The actor is the one a soft-deletable model records; on a model that does not
  soft-delete you call `delete()` with no arguments.
- `forceDelete()` removes rows for real, and runs the same hooks as a delete.
- `upsert(data)` runs no write hooks, because one statement cannot tell whether it inserted or updated.
- `upsertBy(check, update)` runs the read hooks for its lookup, and then the hooks of whichever write it ends up doing.
- `restore()` runs `beforeRestore` once, with the query it may still narrow, and then `afterRestore` once, with the rows
  that came back. That is one call each rather than one per row, because a restore is one statement. `withoutHooks()`
  skips either of them, and skipping `afterRestore` also means the rows are not read for it.
- `insert(data)` and `insertMany(rows)` are the raw builders, and they run no write hooks at all.
- `Orm.transaction(fn)` and `withClient(tx)` run nothing on their own. They matter to hooks because `ctx.client` is
  that transaction.

## If you want to narrow a read, or reshape its rows

`beforeRead` runs before the SQL is built, so you can still add clauses to the builder:

```ts
static hooks: OrmHooks<typeof Post> = {
    beforeRead: (q, { phase }) => {
        // The count still sees the archived posts, the page does not.
        if (phase !== 'count') q.whereNull('archived_at');
    },
};
```

`ctx.phase` tells you which read this is: `get`, `first`, `paginate`, `count`, `countDistinct` or `exists`. A method
that delegates reports where it ends up, so `firstMutable()` reports `first`. `paginate()` reports `paginate` and
calls the hook twice, once for the count and once for the page, so you cannot affect one half only.

`afterRead` gets the rows once they were fetched. Change them in place or return an array to use instead:

```ts
afterRead: (rows) => {
    return rows.map((row) => ({ ...row, ends_at: Game.endsAt(row) }));
},
```

Two cases where it is not called:

- the read matched nothing: `first()` returns `null`, `firstOrFail()` throws;
- a hook threw before it. An error in `beforeRead` stops the read before any SQL is sent; an error in `afterRead`
  happens after the statement already ran.

## If you want to change what an insert writes

`beforeInsert` gets the payload you passed to `Orm.create()`. That object is what gets inserted, so changing it in
place is all you need:

```ts
static hooks: OrmHooks<typeof Topic> = {
    beforeInsert: (row, { now }) => {
        row.created_at ??= now();
        row.slug = slugify(row.title);
    },
};
```

Only the engine's own write calls run it:

```ts
await Orm.create(Topic, { title: 'Hooks', created_at: 0 }); // beforeInsert runs
await Topic.orm().insert({ title: 'Hooks', created_at: 0 }); // no hook: the raw builder writes straight through
```

If you insert the row yourself — from a cache, from a second service, anywhere — return it and the engine writes
nothing:

```ts
beforeInsert: async (row) => {
    const cached = await Cache.get(row.key);
    return cached ? { done: cached } : undefined;
},
```

`Orm.create()` then hands your row back, and `afterInsert` still runs. If your hook already did the work
`afterInsert` would do, say so and it is skipped for this row:

```ts
beforeInsert: async (row) => {
    const cached = await Cache.get(row.key);
    if (!cached) return;

    await Cache.forgetEntryRelated(); // done here, so `afterInsert` is skipped for this row
    return { done: cached, skipAfterHook: true };
},
```

When `afterInsert` does run, that is where the work which must happen either way belongs:

```ts
afterInsert: async (row) => {
    await Cache.forget(`topic:${row.id}`); // runs whether the engine inserted the row or the hook did
},
```

More about `afterInsert`: it receives the row as it is in the database, and it may change that object — that is the
row the caller gets, but nothing is written a second time. If `beforeInsert` throws, nothing is inserted and the error
comes out of `Orm.create()`.

## If you want to change what an update writes

`beforeUpdate` runs for `save()` on a mutable row and for `Orm.update(Model, pk, data)`. It gets the columns about to
be written, and `ctx.original` is the row as it was read:

```ts
beforeUpdate: (row, { now, original }) => {
    row.updated_at = now();
    if (row.status !== original.status) row.status_changed_at = now();
},
```

The engine compares what you changed with the row it read and writes only the columns that differ. A `save()` that
changed nothing writes nothing and does not run `afterUpdate` either.

If you write the row yourself, return the row and the engine writes nothing:

```ts
beforeUpdate: async (row, { original }) => {
    if (!needsReindex(row)) return;
    await search.reindex(original);
    return { done: original }; // save()/Orm.update() hand this row back, and afterUpdate still runs
},
```

Add `skipAfterHook: true` to that return value when the hook also did whatever `afterUpdate` would do.

`afterUpdate` gets the row as it is now, so it is a good place for work that must happen after any update:

```ts
afterUpdate: async (row) => {
    await Cache.forget(`game:${row.id}`);
},
```

Throwing writes nothing.

## If the update touches many rows: `updateAll()`

`updateAll(payload)` runs `beforeUpdate` once for the whole statement. The payload your hook gets is the payload every
matching row will receive, so a change made in place reaches all of them. There is no `ctx.original` here — there is
no single row to compare against — and no `afterUpdate`.

Return `{ done: count }` to skip the statement and make that count the result of `updateAll()`:

```ts
static hooks: OrmHooks<typeof AuditLog> = {
    beforeUpdate: (row, { original }) => {
        // An append-only model: there is no `original` on a bulk update, so refuse it and report 0 rows.
        if (!original) return { done: 0 };
    },
};
```

## If you want a say in a delete

If your model declares `beforeDelete` or `afterDelete`, the engine deletes one row per statement. It first selects
the rows the query matches, then runs `beforeDelete` for each of them, and only then deletes. That is why a hook that
throws leaves every row untouched. Those rows are read with all the columns, even if your query called `select(...)`.

`beforeDelete` decides one thing for its row: delete it or keep it.

```ts
static hooks: OrmHooks<typeof User> = {
    beforeDelete: (user) => {
        // System accounts are never deleted.
        if (user.role >= UserRole.system) return false;
    },
};
```

- returning nothing deletes the row;
- returning `false` keeps the row: it is not deleted, `delete()` does not count it, and `afterDelete` does not see it;
- throwing stops the whole delete, and nothing has been deleted yet.

The row you get is the copy the engine read for you. Changing it does nothing, because the delete is its own statement
and not a save of that object. If you want to keep the row and change it, do your own write and return `false`:

```ts
beforeDelete: async (game, { client }) => {
    if (!game.locked) return;

    await Game.orm(client).where('id', game.id).updateAll({ retired_at: Date.now() });
    return false;
},
```

`afterDelete` runs for each row that was deleted, so it is the place for your own cleanup:

```ts
afterDelete: async (row, ctx) => {
    if (ctx.isLastCall) await Cache.forgetEntryRelated(); // once for the delete, not once per row
    await Cache.forget(`game:${row.id}`); // and whatever belongs to the row itself
},
```

### Following a delete to other models

`ctx.softDelete` and `ctx.deletedBy` are what make a cascade possible: a hook can tell a marked row from a removed
one, and pass the same actor on. A user's account going away, with its entries going the same way — marked _and_ told
why, in one statement each:

```ts
static hooks: OrmHooks<typeof User> = {
    afterDelete: async (user, ctx) => {
        // A hard delete leaves nothing to cascade to.
        if (!ctx.softDelete) return;

        await Entry.orm(ctx.client)
            .where('created_by', user.id)
            .delete(ctx.deletedBy, { delete_reason: EntryDeleteReason.authorWasSoftDeleted });
    },
    afterRestore: async (users, ctx) => {
        for (const user of users) {
            // The reason is what tells the ones the account took from the ones the author removed.
            await Entry.orm(ctx.client)
                .where('created_by', user.id)
                .where('delete_reason', EntryDeleteReason.authorWasSoftDeleted)
                .restore();
        }
    },
};
```

`ctx.client` is the caller's transaction, so wrap the original `delete()` in `Orm.transaction(...)` when the account
and its rows have to move together. This is not a database `ON DELETE CASCADE`: a soft delete never removes a row, so
the foreign key never fires.

A model that declares no delete hook has nothing to run, so the engine deletes every matching row with a single
statement. `withoutHooks('beforeDelete', 'afterDelete')` asks for that same single statement on a model that does
declare them.

## Rules that apply to all of them

- A hook on a base model runs for every subclass: base model first, then each subclass's own.
- Hooks may be async. The engine awaits them everywhere.
- `withoutHooks('beforeUpdate')` skips one hook for one statement and leaves the others alone. The skip belongs to the
  builder you set it on, so a builder the engine creates for a subquery (a preload, a `whereHas`) starts clean.
- Hooks receive plain rows, not model instances.
- A hook refuses by throwing. Nothing is written, and the error is yours: the engine has no error class for it, so use
  your own `code` if the app maps errors.
- A throw inside a transaction rolls that transaction back, like any other error raised in it.
