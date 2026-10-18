/**
 * The AdonisJS adapter for `@mergehez/ormvan`: the pieces that speak AdonisJS' contracts, kept out of the
 * framework-agnostic engine so an app that does not use AdonisJS never installs them.
 *
 * Importing this module re-exports the whole engine and narrows its request context to `HttpContext` (see
 * `./context.ts`), so an AdonisJS app can `import { Orm, PlainBaseModel } from '@mergehez/ormvan-adonisjs'` in one place and
 * get the typed context in `save(ctx)`. The store, the rules and the command live on their own subpaths —
 * `@mergehez/ormvan-adonisjs/orm_session`, `@mergehez/ormvan-adonisjs/orm_vine`, `@mergehez/ormvan-adonisjs/commands/orm_migrate` — so each is
 * reached without pulling the others (or their optional peers) in.
 */
import './context.ts';

export * from '@mergehez/ormvan';
