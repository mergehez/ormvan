/**
 * What AdonisJS tells the engine's framework-agnostic core: what a request context is.
 *
 * Core declares `OrmContext` empty, because the engine reads no member of a context — it only forwards the value it
 * is handed from `row.save(ctx)` to the configured `getAuthUser(ctx)`. AdonisJS knows that value is an `HttpContext`,
 * so this module widens the core interface to it. Every entry point of this package imports this module, which is
 * what makes `save(ctx)` and `getAuthUser(ctx)` speak `HttpContext` in an app that depends on the adapter.
 */
import type { HttpContext } from '@adonisjs/core/http';

declare module '@mergehez/ormvan' {
    interface OrmContext extends HttpContext {}
}
