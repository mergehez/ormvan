# Writing

This page is about the calls that change data: inserting rows, updating them, and deleting them.

## The calls that write

Two of them are statics on `Orm`, and the rest are methods on the builder that `Model.orm()` returns. Every one of them
names the model at the call site, which is what lets the engine use your app's configuration — the clock it stamps with,
and the user it attributes the write to — without you passing either one:

```ts
// Insert one row. Whatever a `beforeInsert` hook stamped goes in with it.
const topic = await Orm.create(Topic, { title: 'Hooks', created_at: dt.unix() });

// The same insert inside a transaction: the read-back and the hooks use that client.
await Orm.create(Topic, { ...payload, created_at: dt.unix() }, { client: tx });

// Update one row, by primary key.
await Orm.update(Game, game.id, { status: GameStatus.finished });

// Bulk write: the WHERE clause is the whole query.
await Topic.orm().where('pinned', 0).updateAll({ archived: 1 });

// Delete. A soft delete for a model that configures one, a real DELETE otherwise.
await Game.orm().where('id', id).delete(actorId);
```

## If a column is missing, it does not compile

A create payload has to carry every column that cannot be NULL, so leaving one out is a compile error rather than a
value the database fills in behind your back:

```ts
await Orm.create(Topic, { title: 'Hooks' });
//                    ^ Property 'created_at' is missing
```

There is also no list of "defaulted columns" that the engine consults, so it never guesses which columns you meant to
leave out. The payload you write is the set of columns the statement writes.

## Plain rows, and rows you can save

A read hands you one of two kinds of row, and which one you get is decided by the method you call. `first()`,
`firstOrFail()` and `get()` give you a plain row: the data, with nothing attached to it. `firstMutable()`,
`firstOrFailMutable()` and `getMutable()` give you a row that also has `save()` and `refresh()` on it:

```ts
const plain = await Game.orm().where('id', id).first();

const mutable = await Game.orm().where('id', id).firstMutable();
mutable.status = GameStatus.finished;
await mutable.save(); // writes `status`, plus whatever a hook stamps
```

`save()` writes only the columns that changed since the row was read, and it runs the update hooks. A column that
holds JSON counts the same way whether you replace the whole value or reach inside it, and one you did not touch is
left out of the write:

```ts
mutable.settings.flags.beta = true;  // written: the row compares against what was read
mutable.mentions;                    // untouched, so not written
```

Keeping the two kinds of row apart is what makes it hard to write a plain row back by accident: if you want to save a
row, you have to have asked for the kind of row that can be saved.

If you want the newest rows first, `latest()` orders by the primary key descending, and `oldest()` is its mirror. Pass a
column when the key is not the time you mean:

```ts
const newest = await Message.orm().where('receiver_id', id).latest().first();
const newestFive = await Message.orm().latest('sent_at').limit(5).get();
const firstEver = await Message.orm().oldest().first();
```

Ordering by the same column twice replaces the first clause rather than adding a second one, so `latest()` overwrites an
earlier ordering on that column and leaves the clauses for other columns where they are.

## Bulk writes, with `updateAll()`

`updateAll(payload)` writes one statement for every row the query matches, and returns how many rows it changed. That
makes the WHERE clause the only thing standing between you and the whole table, so the rules are worth knowing:

- it refuses to run without a WHERE clause;
- it applies the model's soft-delete scope, unless the chain called `withTrashed()`;
- it runs `beforeUpdate` once, with the payload and without `original`, because there is no single row to compare
  against — a hook that stamps a timestamp therefore stamps every row the statement matches;
- it never runs `afterUpdate`, since one statement is not one row.

```ts
await Topic.orm().where('id', id).updateAll({ pinned: 1 }); // ok
await Topic.orm().updateAll({ pinned: 1 }); // Error: Dangerous Operation: Bulk update attempted without a WHERE clause.
```

## Deleting rows

`delete()` marks or removes the rows the query matches, depending on whether the model configures a soft delete, and
returns how many rows it touched. `deleteBy(pk, actor)` is the same delete, narrowed to one row.

Whether you pass an actor depends on the model. A model that soft-deletes writes the actor into `deleted_by`, so its
`delete(actor, extra?)` and `deleteBy(pk, actor, extra?)` ask for one; a model that does not records nothing, so its
`delete()` takes no arguments. The optional `extra` is a map of columns to write in the same `UPDATE`. `forceDelete()` is
the hard delete for a model that soft-deletes, for when a row should go for good.

How many statements a delete runs depends on the model's hooks:

- if the model declares `beforeDelete` or `afterDelete`, its rows are deleted one at a time, so a hook sees the row it is
  deciding about;
- if it declares neither, every row the query matches goes in a single statement;
- if you call `withoutHooks('beforeDelete', 'afterDelete')` yourself, you get that single statement back.

## Upserts

```ts
// One INSERT ... ON DUPLICATE KEY UPDATE, keyed on the primary key. No hooks run.
await User.orm().upsert({ id: 1, username: 'mazlum' });

// A read, and then a write. Can match any unique index, and runs the hooks of whichever half it ends up doing.
const user = await User.orm().upsertBy({ username: 'mazlum' }, { last_seen: dt.unix() });
user.last_seen; // the row as it now is, inserted or updated
```

`upsert()` runs no write hooks, because one statement cannot tell whether it inserted or updated. `upsertBy()` does
know, since it looks the row up first.

## Writing rows without hooks: `insert()` and `insertMany()`

These are the raw builders. They write rows and run no write hooks. What `insert()` writes depends on its argument:

- a payload writes one row, and the call returns its key;
- a builder writes every row that query produces, and the call returns how many rows landed.

```ts
const id = await Topic.orm().insert({ title: 'Hooks', created_at: 0 }); // one row; the key comes back

const copied = await Entry.orm().insert(Entry.orm().where('game_id', game.id).select(colAs('id', 'entry_id'), colAs('game_id', 'game_id')));
// INSERT IGNORE INTO entries (entry_id, game_id) SELECT ...
```

The select names its target columns with aliases (`colAs('id', 'user_id')`), so every value is written next to the
column it belongs to, instead of in two parallel lists that can drift out of order. A row set is a builder passed as the
argument; a builder used as a value inside a payload is a scalar subquery.

## If a value has to be an expression

Anywhere a value goes, you can pass `dbRaw(sql, bindings?)`, a builder, or `countSql()`, and the engine inlines it where
the `?` would have been. Inside `updateAll()`'s callback, `q.ref('user_id')` refers to the row being updated:

```ts
// Write the count straight from the subquery, so the stored number cannot go stale.
await UserStatistics.orm().updateAll((q) => ({
    entries: Entry.orm().where('created_by', q.ref('user_id')).countSql(),
}));
```

`count()` runs the same `countSql('total')`, so a number you counted and a number you wrote cannot come out different.

MySQL accepts some of these combinations and refuses others, which is worth knowing before you rely on one. These three
were tested on MySQL 8.0.33:

| statement                                                                               | result                                                                                  |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `INSERT IGNORE INTO t (a, b) SELECT s.id, 0 FROM s WHERE s.id NOT IN (SELECT a FROM t)` | OK — the builder argument                                                               |
| `INSERT IGNORE INTO t (a) VALUES ((SELECT id FROM t))`                                  | `ER_UPDATE_TABLE_USED` — _You can't specify target table 't' for update in FROM clause_ |
| `VALUES ((SELECT COUNT(*) FROM other))`                                                 | OK — one row                                                                            |
