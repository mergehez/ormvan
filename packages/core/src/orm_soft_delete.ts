/**
 * Soft delete: configured per model, and OFF unless a model asks for it — no scope on reads, no active predicate in
 * a relation join, and no `withTrashed()` on its builder.
 *
 * ```ts
 * class MyBaseModelSoftDeletable extends SoftDeletes(MyBaseModelWithUpdatedAt) {}   // `deleted_at` + `deleted_by`
 * ```
 *
 * The mixin carries the config AND installs the chain's soft-delete methods. A model that opts in with the bare
 * `static softDelete = defaultSoftDelete` gets the behaviour; the methods come from `softDeleteScopes`.
 */
import { scope, type ModelColumn, type RowOf } from './orm_builder.ts';
import type { OrmBuilderState } from './orm_builder_state.ts';
import { ormConfig } from './orm_config.ts';
import { modelHelpers as helpers, modelMeta } from './orm_helpers.ts';
import type { OrmHookContext, OrmHookName } from './orm_hooks.ts';
import { runAfterRestore, runBeforeRestore } from './orm_hooks.ts';
import { OrmModelBase } from './orm_model_base.ts';
import type { OrmModel } from './orm_model_contract.ts';
import { assignments, quoteId, resultHeader } from './orm_sql.ts';
import type { NormalizeConstructor } from './shared/types.ts';

/**
 * What the four scopes need from a builder: the model (the config says what each one does), the state handle the
 * engines drive, and, for the two that run SQL, the statement runner, the delete, and the hook names this statement
 * was asked to skip. Structural on purpose: this module is imported BY the builder modules, so it cannot name them.
 */
type SoftDeleteTarget = {
    model: OrmModel;
    __internals(): OrmBuilderState;
    runExec(sql: string, bindings: readonly unknown[]): Promise<unknown>;
    delete(deleteById: SoftDeleteActor): Promise<number>;
    skippedHooks: ReadonlySet<OrmHookName>;
};

/** The body of the two toggles: this chain's own soft-delete scope is off from here on. */
function dropScope(b: SoftDeleteTarget) {
    b.__internals().enableSoftDeleteGuard = false;
    return b;
}

/**
 * The body of `restore()`: the un-delete statement plus the WHERE the chain built, with the model's restore hooks
 * around it. They run once each — unlike a delete's per-row pair — because a restore is one statement: a hook that
 * wants less restored narrows the query.
 */
async function restoreScope(b: SoftDeleteTarget): Promise<number> {
    const state = b.__internals();
    const { tableName, whereEngine } = state;
    const statement = restorePlan(b.model, tableName, ormConfig().now());

    const ctx: OrmHookContext = {
        client: state.client,
        now: () => ormConfig().now(),
        withoutHooks: b.skippedHooks,
        isFirstCall: true,
        isLastCall: true,
    };
    await runBeforeRestore(b.model, b, ctx);

    // Compiled after `beforeRestore`: a hook that narrowed the query is what runs.
    const where = whereEngine.compileWhereClauses();
    if (!where) throw new Error('Dangerous Operation: Bulk restore attempted without a WHERE clause.');

    // The rows are read only for a hook that wants them (`afterRestore`): they are what a cascade needs, and one
    // extra SELECT is the price of asking.
    const rows = wantsRows(b) ? await rowsToRestore(b, where) : [];

    const sql = `${statement.sql} WHERE ${where}`;
    console.log(sql);

    const affected = resultHeader(await b.runExec(sql, [...statement.bindings, ...whereEngine.bindings()])).affectedRows ?? 0;
    if (rows.length > 0) await runAfterRestore(b.model, rows, ctx);

    return affected;
}

/** Whether this restore has to read its rows first: `afterRestore` is declared and not skipped. */
function wantsRows(b: SoftDeleteTarget): boolean {
    return helpers.restoreHooks(b.model).includes('afterRestore') && !b.skippedHooks?.has('afterRestore');
}

/**
 * The rows a restore is about to un-mark, read with the model's own columns: a hook decides on a column, so the
 * chain's own `select(...)` must not hide one from it.
 */
async function rowsToRestore(b: SoftDeleteTarget, where: string): Promise<Record<string, unknown>[]> {
    const state = b.__internals();
    const selected = state.selectEngine.all();
    state.selectEngine.replaceAll([]);
    try {
        const columns = state.selectEngine.selectList(b.model, []);
        const sql = `SELECT ${columns} FROM ${state.tableName} WHERE ${where}`;

        return await (state.client ?? ormConfig().getExecutor()).query(sql, state.whereEngine.bindings());
    } finally {
        state.selectEngine.replaceAll(selected);
    }
}

/** The body of `forceDelete()`: the chain's own delete, with the soft-delete scope off. */
async function forceDeleteScope(b: SoftDeleteTarget): Promise<number> {
    b.__internals().enableSoftDeleteGuard = false;
    return b.delete(null);
}

/**
 * The soft-delete surface, as the scopes the mixin declares. Being scopes, these exist on the chain of a model that
 * opted in and nowhere else — and the two toggles set the flag on the builder they are called on: the subqueries a
 * chain spawns keep their own scope, and lift it in their own callback.
 */
export const softDeleteScopes = {
    /** Includes this chain's trashed rows (and counts them, when it counts). */
    withTrashed: scope(dropScope),
    /** The same flag, for a call site whose intent is "do not apply the scope" rather than "include trashed rows". */
    ignoreSoftDeleteGuard: scope(dropScope),
    /** Un-deletes the rows this chain matches, in one statement — so the chain needs a WHERE. */
    restore: scope(restoreScope),
    /** Deletes the rows this chain matches for real, without asking the model's soft delete. */
    forceDelete: scope(forceDeleteScope),
};

/**
 * The two toggles as METHODS, for a surface that hands out a builder class instead of the chain type (`withCount`'s
 * callback). `T extends this` is the engine's `__claim` idiom: the receiver comes back, so a callback keeps chaining.
 */
export interface SoftDeleteToggleMethods {
    /** Includes the relation's trashed rows in this count. */
    withTrashed<T extends this>(this: T): T;
    /** The same flag, for a call site whose intent is "do not apply the scope". */
    ignoreSoftDeleteGuard<T extends this>(this: T): T;
}

/**
 * Those methods, present only when the model opted in — the count surface cannot carry the chain's `ScopeMethods`
 * (a mapped type over every scope) without exceeding what TS resolves, so it takes the two shapes by name.
 */
export type SoftDeleteToggles<X extends OrmModel> = X extends { withTrashed: unknown; ignoreSoftDeleteGuard: unknown } ? SoftDeleteToggleMethods : {};

/**
 * Everything the engine needs to know about one model's soft delete. `column` and `by` name DB columns; the two
 * predicates are SQL over a table reference, so an app whose "live" test is not `IS NULL` can say so.
 */
export interface SoftDeleteConfig {
    /** The column holding the deletion stamp. */
    column: string;
    /** The column recording who deleted the row — omit for a single-column soft delete. */
    by?: string;
    /** SQL for "this row is live", over a table reference. Default `<ref>.<column> IS NULL`. */
    activeSql?: (ref: string) => string;
    /** SQL for "this row is deleted". Default `<ref>.<column> IS NOT NULL`. */
    trashedSql?: (ref: string) => string;
    /**
     * The value written into `column` on delete. Default the app clock (`Orm.now()`). Whatever it returns is
     * BOUND, so the column may be an int, a `datetime`, a string or a uuid.
     */
    stamp?: (now: number) => unknown;
    /**
     * The value `restore()` writes back into `column` and `by` — `NULL` by default, which is what the default
     * live-row predicate reads. A schema whose "live" value is a sentinel (`0`, `''`, a fixed uuid) says so.
     */
    live?: (now: number) => unknown;
}

/** Who a soft delete attributes the row to: an id of either shape, or nobody. */
export type SoftDeleteActor = string | number | null;

/** `<ref>.deleted_at IS NULL` — the "live row" predicate, qualified so it survives a join. */
export const activeRowSql = (config: SoftDeleteConfig, ref: string) => (config.activeSql ?? ((r: string) => `${r}.${config.column} IS NULL`))(ref);

/** `<ref>.deleted_at IS NOT NULL` — the complement, for a purge/restore that targets deleted rows. */
export const trashedRowSql = (config: SoftDeleteConfig, ref: string) => (config.trashedSql ?? ((r: string) => `${r}.${config.column} IS NOT NULL`))(ref);

/**
 * The config a model carries, or `undefined` (no soft delete). Read off the class, so a base class that
 * composes the mixin gives it to every subclass — which is how the apps declare it once.
 */
export function softDeleteOf(model: OrmModel | undefined): SoftDeleteConfig | undefined {
    return (model as { softDelete?: SoftDeleteConfig } | undefined)?.softDelete;
}

/**
 * Whether a model class carries a soft-delete config, directly or through its base — the type-level twin of
 * `softDeleteOf`. It is what keeps the actor parameter on `delete()` only where a soft delete writes it down (see
 * the main query builder), and the runtime mirror of it is `softDeleteOf`'s own check.
 */
export type SoftDeletable<X extends OrmModel> = X extends { softDelete: SoftDeleteConfig } ? true : false;

/**
 * The extra columns a soft delete may write besides the config's two (`delete(actor, { reason: 2 })`). Hidden columns
 * are allowed: this is a write, not a projection — so it is picked from the model, not from the visible row type.
 */
export type SoftDeleteExtra<X extends OrmModel> = Partial<Pick<RowOf<X>, ModelColumn<X> & keyof RowOf<X>>>;

/**
 * That base class' config line, which is the whole behaviour opt-in: a model that carries it is soft-deleted. The
 * chain methods come with `SoftDeletes(...)` (or by assigning `softDeleteScopes`).
 */
export const defaultSoftDelete: SoftDeleteConfig = { column: 'deleted_at', by: 'deleted_by' };

/**
 * The mixin form, the way an app declares this once for a whole tree of models: it carries the config and installs
 * the chain methods. The app declares the `deleted_at`/`deleted_by` columns where its schema is.
 */
export function SoftDeletes<T extends NormalizeConstructor<typeof OrmModelBase>>(Base: T) {
    return class SoftDeleteModel extends Base {
        static softDelete: SoftDeleteConfig = defaultSoftDelete;
        static withTrashed = softDeleteScopes.withTrashed;
        static ignoreSoftDeleteGuard = softDeleteScopes.ignoreSoftDeleteGuard;
        static restore = softDeleteScopes.restore;
        static forceDelete = softDeleteScopes.forceDelete;
    };
}

/**
 * `UPDATE <table> SET <column> = ?, <by> = ?` plus the values to bind — the stamp comes from the config, or the
 * app clock: never MySQL's `NOW()`, since these schemas store unix ints. `extra` is written by the same statement,
 * so a reason column can never disagree with the mark that hid the row.
 */
export function softDeleteStatement(config: SoftDeleteConfig, table: string, deleteById: SoftDeleteActor, now: number, extra: ExtraAssignment[] = []) {
    const columns = [config.column];
    const bindings: unknown[] = [(config.stamp ?? ((seconds: number) => seconds))(now)];

    if (config.by) {
        columns.push(config.by);
        bindings.push(deleteById);
    }

    for (const assignment of extra) {
        columns.push(assignment.column);
        bindings.push(assignment.value);
    }

    return { sql: `UPDATE ${quoteId(table)} SET ${assignments(columns)}`, bindings };
}

/** One extra column of a soft delete, already named as the database knows it. */
type ExtraAssignment = { column: string; value: unknown };

/** The extra columns a caller passed, keyed by DB column name. */
function extraAssignments(model: OrmModel, extra: Record<string, unknown> | undefined): ExtraAssignment[] {
    if (!extra) return [];

    const columnNames = modelMeta(model).columnNames;
    return Object.entries(extra).map(([property, value]) => ({ column: columnNames.get(property) ?? property, value }));
}

/**
 * `UPDATE <table> SET <column> = ?, <by> = ?` — the un-delete half. The caller supplies the WHERE, so a restore
 * cannot run unscoped.
 */
export function restoreStatement(config: SoftDeleteConfig, table: string, now: number) {
    const columns = [config.column, ...(config.by ? [config.by] : [])];
    const live = (config.live ?? (() => null))(now);

    return { sql: `UPDATE ${quoteId(table)} SET ${assignments(columns)}`, bindings: columns.map(() => live) };
}

/**
 * The whole soft delete of one statement: the SET half, its values, and the live-row scope to AND into the
 * caller's WHERE. `null` when the model has none (or the guard is off).
 */
export type SoftDeletePlan = { sql: string; bindings: unknown[]; scope: string } | null;

export function softDeletePlan<X extends OrmModel>(
    model: X | undefined,
    table: string,
    deleteById: SoftDeleteActor,
    now: number,
    enabled = true,
    extra?: SoftDeleteExtra<X>
): SoftDeletePlan {
    const config = enabled ? softDeleteOf(model) : undefined;
    if (!config) return null;

    const statement = softDeleteStatement(config, table, deleteById, now, model ? extraAssignments(model, extra) : []);
    return { ...statement, scope: activeRowSql(config, table) };
}

/**
 * The same for `restore()`: the statement plus an explicit "no soft delete configured". A model with no config has
 * no `restore()` to call, so this is the guard for one that wired the scope without the config — an error rather
 * than a silent no-op.
 */
export function restorePlan(model: OrmModel, table: string, now: number) {
    const config = softDeleteOf(model);
    if (!config) throw new Error(`restore() on '${model.name}': the model has no soft delete configured.`);

    return restoreStatement(config, table, now);
}
