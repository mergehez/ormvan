# Configuration

## Configuring the engine, once per app

The engine exports one class, `Orm`, and one base model, `PlainBaseModel`. You never subclass `Orm`. An app calls
`Orm.configure` once while it boots, and every query after that reads that configuration:

```ts
// <app>/app/orm/project_orm.ts
import { Orm, PlainBaseModel } from '@mergehez/ormvan';
```

An AdonisJS app imports `@mergehez/ormvan-adonisjs` here instead, which re-exports the same `Orm` and `PlainBaseModel` and adds
the framework-specific pieces.

```ts
Orm.configure({
    getExecutor: (connectionName) => connections.executor(connectionName), // how to reach MySQL
    now: () => dt.unix(), // the clock behind `updated_at` stamping
    getAuthUser: (ctx) => authUser(ctx), // who is acting, behind `updated_by` stamping
});

export { Orm };
export class ModelBase extends PlainBaseModel {}
```

The engine has no connection of its own, no clock, and no idea who is logged in, so it asks the app for all three.
Those callbacks are where the app answers.

## Declaring a model

A model names its table, its columns and its relations. The engine reads those declarations to work out the type of
your rows, and to know which columns it is allowed to write.

```ts
export class Game extends ModelBase {
    static table = 'games'; // optional: without it, the class name decides (e.g. `UserBlock` → `user_blocks`)

    @column({ isPrimary: true }) declare id: number;
    @column() declare title: string;
    @column() declare status: number;
    @column() declare created_at: number;
    @column() declare internal_note: string | null;

    @belongsTo(() => User, { foreignKey: 'created_by' })
    declare creator: BelongsTo<typeof User>;

    @hasMany(() => Entry, { foreignKey: 'game_id' })
    declare entries: HasMany<typeof Entry>;
}
```

Read it back with a chain:

```ts
const games = await Game.orm().where('status', GameStatus.running).orderBy('id', 'desc').limit(10).get();

games[0].title; // typed, because the model declares `title`
```

## Hidden columns

A column the app should not hand out — a password, an internal flag — is named in the model's `static hiddenColumns`
list, which is the only place hiding is declared:

```ts
export class User extends ModelBase {
    static table = 'users';
    static readonly hiddenColumns = ['password', 'remember_token'] as const;

    @column() declare username: string;
    @column() declare password: string;
    @column() declare remember_token: string | null;
}
```

It stays out of the SELECT unless a query asks for it (`select`, `withHidden`) and `omitHidden(row)` drops it at the
response boundary. That is also what the types see: `RowOf<User>` has no `password`, `withHidden` accepts only names
from the list, and it follows the model into a preload of it. Hiding is about the projection, though — it is not a ban
on using the column, so a predicate, an ordering, a grouping, a count or a `q.ref(…)` may still name it:

```ts
const users = await User.orm().whereNotNull('password').orderBy('password').get();
```

## If you want your own query methods

An app's own query methods go on `ModelBase`, wrapped in `scope(...)`. A scope exists on every kind of builder the
engine hands to a callback — a main chain, and the callbacks it compiles into subqueries — so you write a filter once
and use it anywhere:

```ts
export class ModelBase extends PlainBaseModel {
    static withRatingCount = scope((b: SubqueryBuilder<OrmModel>, kind: 'fav' | 'cepik' | 'resik', userId?: number) => b.withCountUnchecked(`${kind}s`).__claim());
}
```

The first parameter is the builder the scope needs, so a scope written for a subquery builder cannot be called on a
builder that does not offer one:

```ts
const games = await Game.orm().withRatingCount('fav', userId).get();
const entries = await Game.orm()
    .preloadCb('entries', (q) => q.withRatingCount('resik'))
    .get(); // same method
```

`__claim()` is for a scope that calls several chain methods and returns once: it tells the type system that the row
carries whatever those calls added. A method declared on `ModelBase` without `scope(...)` is not on a chain — only the
engine's own methods and what `scope(...)` produced are.

## What the engine asks the app for

The engine keeps everything app-flavoured out of itself. Where it needs one of those things, it either brings its own
copy or reads it from the configuration:

| needs                                                      | where it comes from                                 |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `objKeys`                                                  | own helper (`packages/core/src/orm_mutable.ts`)     |
| `PaginatedResult`                                          | own type (`packages/core/src/shared/types.ts`)       |
| `dt.unix()` (updated_at/updated_by stamping)               | `Orm.configure({ now })`                            |
| `getAuthUser(ctx)`                                         | `Orm.configure({ getAuthUser })`                    |
| the executor                                               | `Orm.configure({ getExecutor })`                    |
| `Cols<T>` excluding the base model's members and relations | own types (`Cols`/`ColsOf` in `packages/core/src/orm_builder.ts`) |
