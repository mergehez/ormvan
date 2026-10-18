# Deliberate omissions

Some things this engine does not do, and will not do. They are choices rather than gaps, so that you do not spend an
afternoon looking for a switch that is not there.

## A scope exists on every flavour, including where it is useless

`restore()` and `forceDelete()` are scopes, and a scope is attached to every kind of builder the engine hands to a
callback. So a `preloadCb` or a `whereHas` callback has both of them in its type, and calling one there throws: they need
the statement runner, which lives on the main builder, and neither of them means anything inside a subquery. The engine
does not hide them per flavour, because that would cost a marker on every scope it declares. The count flavour is the
exception, and carries the two toggles by name.

## If you declare only the configuration, you get no chain methods

The engine reads `static softDelete` for the columns and the actor, and it cannot infer the four chain methods from it.
A model that declares the configuration alone therefore gets the behaviour without `withTrashed()`,
`ignoreSoftDeleteGuard()`, `restore()` or `forceDelete()`. Giving that model a base of its own —
`class Base extends SoftDeletes(MyModelBase) {}` — is how you keep the two declarations together without adopting a
base that carries more than you want. `softDeleteScopes` is the last resort, for a model whose base the mixin cannot
extend.

## The seed data belongs to the app

The engine ships no seeder. An app supplies its own, and `orm:migrate --seed` runs that one.
