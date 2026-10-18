# Joins and unions

## What a join adds to a row

`join(Game, 'game_id', '=', 'id')` adds the game table to the query, and the game's columns to every row that comes
back. You read them as typed properties beside your model's own columns, because the row stays one flat row:

```ts
const moves = await Move.orm()
    .join(Game, 'game_id', '=', 'id') // INNER JOIN games ON moves.game_id = games.id
    .leftJoin(User, 'created_by', '=', 'id') // LEFT JOIN users ON moves.created_by = users.id
    .get();

moves[0].title; // Game's column: typed, and selected
moves[0].move_index; // Move's own column
```

The two columns you pass are read in order. The left one belongs to your model and the right one to the model you are
joining, and you write both without a table name — the engine adds the table each side belongs to.

## Where a join can go

A join belongs to the query that owns the FROM clause. The engine compiles a few shapes of query: the main chain, a
preload callback (a subquery with a FROM of its own), a `whereHas` (an EXISTS) and a count subquery (a COUNT). Only the
first two own a FROM, so a `whereHas` callback and a count callback have no join method at all: they contribute a WHERE
and nothing else, and a join written there could never reach the SQL. `tests/builder_surfaces.test.ts` keeps that list
honest for every shape.

## If the joined table has a model

`join()`, `leftJoin()`, `rightJoin()` and `crossJoin()` take a model, and the row gains its columns. Using the model
buys you four things:

- the table name comes from the model, so you cannot misspell it;
- the engine writes both sides of the condition with the table each side belongs to;
- the joined model's visible columns are added to the SELECT, because the row type says they are there;
- a column both tables have — an `id`, typically — stays with your model, so a join cannot shadow it.

If a column name is not enough to express the condition, pass `{ sql: … }` in its place.

## If the table has no model

`joinSql()`, `leftJoinSql()`, `rightJoinSql()` and `crossJoinSql()` are the untyped forms, and they add no columns to
the row. Use them for an alias, or for a table that no model describes:

```ts
const rows = await Entry.orm().joinSql('games as g', 'g.id', '=', 'entries.game_id').get();
```

`joinSub()`, `leftJoinSub()` and `rightJoinSub()` join a derived table — a subquery with an alias.

## Joins inside a preload

A preload callback owns the joins of its own subquery, so you can join there and read the joined columns on each nested
row:

```ts
const games = await Game.orm()
    .preloadCb('entries', (q) => q.join(Entry, 'game_id', '=', 'id'))
    .get();

games[0].entries[0].title; // the joined model's columns are in each nested row
```

A `whereHas` callback and a count callback have no joins, for the reason above: a WHERE is all they contribute.
`union()` stays on a main chain for a similar reason — a preload is one scalar subquery that has to answer with a single
value, so a second set of rows has nowhere to go.

## Referring to the joined table

A bare column name always means your model's column, because the engine qualifies it with your own table. To reach the
other table, name it inside the string: a `table.column` is passed through as written.

```ts
await Move.orm().join(Game, 'game_id', '=', 'id').where('status', 1).get(); // moves.status = 1
await Move.orm().join(Game, 'game_id', '=', 'id').where('games.status', 1).get(); // games.status = 1
```

Ordering, grouping and HAVING take a qualified name the same way, so a join can be sorted and grouped on the joined
table:

```ts
await Move.orm().join(Game, 'game_id', '=', 'id').where('games.status', 1).groupBy('games.title').having('games.title', '!=', '').orderBy('games.title').get();
```

For an expression that the column form cannot express, `whereRaw('games.status = ?', [1])` is still there.

## Unions

```ts
const rows = await Entry.orm()
    .select('id')
    .where('status', 1)
    .union(Entry.orm().select('id').where('status', 2)) // same chain type, so the rows cannot disagree
    .get();
```

`union(member)` and `unionAll(member)` put brackets around each side, so an `ORDER BY` or a `LIMIT` stays with the query
it was set on. The member has to be the same chain type — the same model, and the same `select(...)` — and it compiles
when you pass it, so a mismatch is a compile error rather than something you find in production.

`count()`, `countSql()` and therefore `paginate()` count a union as a derived table (`SELECT COUNT(*) FROM (…) AS t`)
instead of counting one side of it. `exists()` and `countDistinct()` compile from your model's own table, so they see
neither the join nor the union.
