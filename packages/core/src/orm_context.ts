/**
 * The request context an app hands to `row.save(ctx)` and the engine forwards, untouched, to the `getAuthUser`
 * callback installed with `Orm.configure()`. The engine reads no member of it: it only carries the value from the
 * save to the callback.
 *
 * Core therefore declares nothing here. A framework adapter augments this interface with its own request context, and
 * every place the engine names `OrmContext` — `save(ctx)` and `getAuthUser(ctx)` — then speaks that adapter's type.
 * An app that imports the adapter gets the narrowed type; an app that imports core alone can pass anything non-null.
 */
export interface OrmContext {}
