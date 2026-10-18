# Soft delete

Use a soft delete when you want deleted rows to stay in the table. `delete()` then marks the row instead of removing
it: the engine writes a value into a column you choose — commonly `deleted_at`, but you can pick another — and leaves the rest of the row as
it was. The row is still there for support, for a report, or for a user who wants their post back, and your application
behaves as if it were gone, because every read on that model skips marked rows.

You tell the engine which column holds the marker and — if you want to record it — which one holds the actor. You do
that once, on the model. After that, the calls you were already writing do the new thing:

```ts
// Marks the row instead of removing it: no `DELETE FROM` is sent.
await Game.orm().where('id', id).delete(actorId);
// UPDATE games SET deleted_at = ?, deleted_by = ? WHERE id = ?

// Reads on this model no longer return it...
await Game.orm().get();

// ...unless you ask for the marked rows too, or bring one back.
await Game.orm().withTrashed().get();
await Game.orm().withTrashed().where('id', id).restore();
```

If a model is not configured, nothing changes for it: `delete()` sends a real `DELETE FROM`, and the methods this page
describes are not on it. The engine never infers soft delete from your schema — you say so, per model.

## If a marker is not enough, write more columns with it

Sometimes you want the delete to say more than "this row is gone". If you hide every row a user wrote when their
account is deleted, for example, each of those rows should also remember that the account is what took it — because
when the account comes back, you want the rows it took, and not the ones the user had deleted themselves.

For that, pass the extra columns as the second argument:

```ts
await Entry.orm().where('created_by', authorId).delete(actorId, { delete_reason: 'account_deletion' });
// UPDATE entries SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE created_by = ?
```

The engine writes them in the same `UPDATE`. You can do the same thing with two statements instead — mark the rows,
then go back and say why — but if your process stops between the two, the rows are left marked with no reason, or with
the reason from an earlier delete. One statement cannot end up half-applied that way.

You can name any column of that model, hidden ones included: hiding is about what a _read_ asks for, and this is a
write. The values are bound like any other value the engine writes, and a name that is not a column of the model will
not compile, so a typo cannot reach the database.

`restore()` takes no such map. What a scope accepts is fixed once, for the whole model, so there is no way to give it
a per-model list of columns. If you want a column cleared when a row comes back, write that yourself right after the
restore, in one `updateAll`.

## Turning it on for a model

Soft delete is per model. If you want it for a set of models, put it on a base class and extend that:

```ts
export class MyBaseModelSoftDeletable extends SoftDeletes(MyBaseModelWithUpdatedAt) {
    @column() declare deleted_at: number | null;
    @column() declare deleted_by: number | null;
}

export default class Game extends MyBaseModelSoftDeletable {}
```

`SoftDeletes(...)` is a mixin: you hand it the base class your models already extend, and it gives you back a class
that extends that one with soft delete configured. It does two things for you — it remembers the configuration (which
column holds the marker, and which one holds the actor), and it puts the four chain methods in place: `withTrashed()`,
`ignoreSoftDeleteGuard()`, `restore()` and `forceDelete()`.

The columns are still declared in your model, next to the rest of its schema, so there is nothing new to look up when
you add a table.

If a model needs a different configuration, restate `static softDelete` on it and keep the methods: a table that has a
`deleted_at` but no `deleted_by`, for instance, names the one column it has.

```ts
export default class Game extends MyBaseModelSoftDeletable {
    static softDelete = { column: 'deleted_at' }; // this table has no `deleted_by`
}
```

If no model in the chain configures soft delete, the model behaves as if the feature did not exist:

- reads and joins add no condition of their own;
- `delete()` sends a real `DELETE FROM`, and takes no actor argument, because there is no column to write one into;
- `withTrashed()`, `ignoreSoftDeleteGuard()`, `restore()` and `forceDelete()` are not on the chain.

That last one is on purpose: calling one of the four on a model that does not soft-delete is a compile error rather
than a call that quietly does nothing, so a wrong assumption about your schema surfaces while you are writing the code
and not later in production.

If you configure a soft delete but name a column your model does not declare, the engine refuses to build the model
and throws `E_ORM_SOFT_DELETE_MISCONFIGURED`, instead of writing to a column that may not exist.

## Why you see `?` instead of `NOW()`

If you log the SQL the engine runs, you will see `?` placeholders rather than values written into the statement, and
that is on purpose. In a schema like the ones this engine is used with, `deleted_at` holds a Unix timestamp as an
integer, and MySQL converts a datetime to its digits when the column expects a number — so `SET deleted_at = NOW()`
would be accepted and would store `20260915175937`. Binding the value means your columns hold the same kind of
timestamp the rest of your application uses, and that the value you see in a log is the value that reached the row.

## If you want the marked rows too

Call `withTrashed()` on the query that should see them. It lifts the filter for that query and for nothing else: each
subquery a chain builds — a preload, a `whereHas`, a count — is a query of its own, so if you want marked rows there as
well, ask in that subquery's own callback:

```ts
await Post.orm()
    .withTrashed() // the posts, marked ones included
    .withCount('comments', (c) => c.withTrashed()) // and the count, which needs its own
    .get();
```

The two answers can disagree, and that is why you write them separately: the posts above include marked rows, while
the count beside each post only reaches comments that are not marked. If a number looks wrong in a query like this,
the subquery that produced it is where the missing (or extra) filter belongs.

## Deleting for real, and putting rows back

- `delete()` marks the rows your query matches, and returns how many it marked. On a model that configures no soft
  delete, the same call removes them for real.
- `forceDelete()` removes rows for real on a model that does soft-delete. The row is gone, and the marker column is not
  touched on the way out. If your interface has a "delete permanently" action, this is what it calls.
- `restore()` puts marked rows back: it writes the value that means "alive" into the marker column (NULL, unless your
  configuration says otherwise) and clears the actor column.

If you want rows that were taken together to come back together, that is what the restore hooks are for. The model's
`beforeRestore` and `afterRestore` run around the statement, so an account's hook can restore the entries it took, and
leave the ones the author had deleted themselves alone. There is a matching pair on the delete side, for doing the same
work in the other direction. [Hooks](./hooks.md) covers both.

The whole implementation is in `packages/core/src/orm_soft_delete.ts`: the configuration, the SQL, and the four chain methods.

## If the related row is marked, the relation is null

If you turn soft delete on for a model that other models point at, preloading it from them gives you `null` whenever
the related row is marked. The preload reads those rows with a query of its own, and that query skips marked rows, so
there is nothing to fill the relation with:

```ts
const entry = await Entry.orm().preload('creator').firstOrFail();
entry.creator; // null, once that user's account is marked
```

The entry itself is read normally and the rest of its columns are all there; only the relation is empty. It is worth
knowing before you switch this on, because a page that shows an author's name will now have a hole in it. `preload()`
types the relation as present, since that is the common case; if a related row can legitimately be missing, use
`preloadMaybe()`, whose type says so.

If you would rather show something than a gap, pass a fallback — the object that stands in for the row that is not
there:

```ts
const deletedUser = { id: -1, username: 'user-not-found' };

const entries = await Entry.orm().preload('creator', ['id', 'username'], deletedUser).get();
```

The fallback goes into the SQL as `IFNULL(<subquery>, CAST(? AS JSON))`, so it works in a nested preload too. It has a
second effect that is often the more useful one: the relation stops being optional, so `entry.creator.username` needs
no `!` and no `if` around it. One constant, written once, describes "this user is gone" everywhere you preload a user.

A to-many preload takes no fallback, because it does not need one: an empty array is already what "there are none"
looks like.

## If your model needs its own base

`SoftDeletes(...)` gives you back a class, so a model that should not extend one of your existing soft-deletable bases
can have a base of its own. That is the case when the near-miss base carries something the table does not want —
nullable audit columns, where your other bases type `created_by` as non-null:

```ts
/** Soft-deletable and nothing else: no audit columns, no extra hooks. */
export class MyBaseModelSoftDeletableNoAudit extends SoftDeletes(MyBaseModel) {}

export class UserModel extends MyBaseModelSoftDeletableNoAudit {
    static table = 'users';

    @column() declare deleted_at: number | null; // the columns stay in the model, where the schema is
    @column() declare deleted_by: number | null;
}
```

The configuration and the four methods come from that one declaration, so they cannot drift apart later.

If your model has to extend some other class, the mixin is out of reach — TypeScript gives a model one base class, and
that one is already taken. You can still turn the behaviour on with the configuration alone, which is enough for
`delete()` to mark rows, but then declare the methods by hand: the engine exports `softDeleteScopes` for that.

```ts
import { defaultSoftDelete, softDeleteScopes } from '@mergehez/ormvan';

class OrderModel extends OrderBaseModel {
    static softDelete = defaultSoftDelete;
    static withTrashed = softDeleteScopes.withTrashed;
    static ignoreSoftDeleteGuard = softDeleteScopes.ignoreSoftDeleteGuard;
    static restore = softDeleteScopes.restore;
    static forceDelete = softDeleteScopes.forceDelete;
}
```
