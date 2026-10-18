/**
 * The write vocabulary: what a write payload may carry, and what a value inside it may refer to.
 *
 * `OrmCreateData`/`OrmUpdateData` are the payloads an entry point asks a caller for; `InsertUpdatePayload`,
 * `UpdatePayload` and `WriteContext` are what the builder's own write members accept.
 */
import type { Cols, ModelColumn, Obj, RowOf } from './orm_builder.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { SqlValue, SubqueryLike } from './orm_where.ts';

// Column keys of `X` as keys of the model instance. Write payloads DO include hidden columns: naming one in an
// INSERT/UPDATE is already an explicit act, unlike reading it off a row.
type ColsKeys<X extends OrmModel> = Extract<Cols<RowOf<X>>, keyof RowOf<X>>;

// Columns that may hold NULL — plus props declared optional (`@notMapped()`/computed) — are
// optional in create payloads; every other column is required.
type NullableCols<X extends OrmModel> = {
    [K in ColsKeys<X>]-?: null extends RowOf<X>[K] ? K : {} extends Pick<RowOf<X>, K> ? K : never;
}[ColsKeys<X>] &
    keyof RowOf<X>;

/**
 * Writable columns for `create`, minus `id`: non-null columns are required, the rest optional. A column is not
 * optional just because the database would default it.
 */
export type OrmCreateData<X extends OrmModel> = Pick<RowOf<X>, Exclude<ColsKeys<X>, 'id' | NullableCols<X>>> & Partial<Pick<RowOf<X>, NullableCols<X>>>;

export type OrmUpdateData<X extends OrmModel> = Partial<OrmCreateData<X>>;

/** One column's value in a write payload: a bound scalar, an expression, or a builder inlined as a scalar. */
export type InsertUpdatePayload = Record<
    string,
    null | undefined | string | number | boolean | Array<unknown> | Obj | SqlValue | { toSQL(): { sql: string; bindings?: unknown[] } }
>;

/** What a callback payload receives: the updated row's own columns, for a correlated subquery. */
export type WriteContext<X extends OrmModel> = {
    /** `user_statistics.user_id` — a column of the row being updated, for use inside a subquery value. */
    ref(column: ModelColumn<X>): SqlValue;
};

/** A builder handed to `insert` as its row source: its select's aliases are the target columns. */
export type RowSource = SubqueryLike & { selectedAliases?(): (string | undefined)[] };

/** Either the payload itself, or a callback that builds it with the updated row's own columns in reach. */
export type UpdatePayload<X extends OrmModel> = InsertUpdatePayload | ((q: WriteContext<X>) => InsertUpdatePayload);
