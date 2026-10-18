/**
 * Model hooks — the engine's before/after for reads and writes:
 *
 * ```ts
 * static hooks: OrmHooks<typeof Game> = {
 *     beforeInsert: (row, { now }) => { row.created_at ??= now(); },
 *     beforeUpdate: (row, { now }) => { row.updated_at = now(); },
 *     beforeRead: (q, { phase }) => { if (phase === 'get') q.whereNull('archived_at'); },
 * };
 * ```
 *
 *  - read hooks run before the SQL is compiled, so `beforeRead` can add clauses;
 *  - each path has its own context type: a read hook gets `ctx.phase`, an update hook `ctx.original`, a delete hook
 *    `ctx.softDelete`/`ctx.deletedBy` — and every hook gets the transaction, the clock, the skip set and the call
 *    flags (`OrmHookContext`);
 *  - `ctx.phase` names the read that fired them — one of `get`, `first`, `paginate`, `count`, `countDistinct`,
 *    `exists`;
 *  - a hook that throws aborts the operation;
 *  - `upsert()` bypasses the write hooks;
 *  - a **write** hook changes the data by mutating the row it is handed — that object *is* the payload the statement
 *    writes (`beforeInsert`, `beforeUpdate`) — or returns `{ done: value }` when it did the work itself: nothing is
 *    written for that row, and that value is the caller's result. The `after…` hook of that write runs either way
 *    (so work that must happen whatever the write did belongs there, or in a `{ done, skipAfterHook }` return);
 *  - `ctx.isFirstCall`/`ctx.isLastCall` say where a hook call sits in the statement — a delete hooks every row it
 *    removes, and the last call is the one to drop a cache entry on;
 *  - a **delete** hook runs once per row and returns `false` to keep its row: the row stays, and `delete()` counts only
 *    the rows it really deleted. A model that declares one is deleted one row per statement, so `beforeDelete(row)`
 *    sees its row and `afterDelete(row)` each row that went; `withoutHooks('afterDelete')` is how a caller asks for
 *    the single bulk statement.
 */
import type { OrmQueryable } from './executor.ts';
import type { OrmBuilder } from './orm_builder.ts';
import type { OrmRow } from './orm_engine.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { SoftDeleteActor } from './orm_soft_delete.ts';

/** The chain surface a read hook may touch — the class alone decides which members that is. */
export type OrmHookBuilder<X extends OrmModel> = OrmBuilder<X>;

/** Which read fired the hook. `'paginate'` fires once for the two statements a paginated read runs. */
export type OrmReadPhase = 'get' | 'first' | 'paginate' | 'count' | 'countDistinct' | 'exists';

/** What every hook is told about the statement it is running in, whatever the path. */
export interface OrmHookContext {
    /** The transaction this statement runs in, when there is one — write in the same one. */
    client?: OrmQueryable;
    /** The app's clock (`Orm.now()`), so a hook stamps times the way the rest of the app does. */
    now(): number;
    /**
     * Hook names this statement asked to skip (`withoutHooks('beforeUpdate')`). The statement decides, not the
     * model.
     */
    withoutHooks?: ReadonlySet<OrmHookName>;
    /**
     * Whether this is the first call this hook gets for the statement. About the hook call, not about a `first()`
     * chain method. A delete calls its hooks once per row, so a row's flags say where it sits; a hook called once per
     * statement (a read, `Orm.create()`, a one-row save, `updateAll`) sees both `true`.
     */
    isFirstCall: boolean;
    /** Whether this is the last call this hook gets for the statement — the one to invalidate a cache on. */
    isLastCall: boolean;
}

/** A read hook's context: which read this is. */
export interface OrmReadHookContext extends OrmHookContext {
    phase: OrmReadPhase;
}

/**
 * An update hook's context: the row as it was READ, so a `beforeUpdate` hook can tell a real change from a `save()`
 * that changed nothing. Absent on a bulk `updateAll`, which has no row to compare against.
 */
export interface OrmUpdateHookContext extends OrmHookContext {
    original?: Record<string, unknown>;
}

/** A delete hook's context: what the statement is about to do to the row, and for whom. */
export interface OrmDeleteHookContext extends OrmHookContext {
    /**
     * Whether this delete MARKS the row (`deleted_at`) instead of removing it. A cascade hook branches on it: a row
     * that is gone has nothing left to cascade to.
     */
    softDelete: boolean;
    /**
     * The actor this delete is attributed to — what the statement writes into `deleted_by`. `null` for a hard delete
     * (no column holds it), or when the caller gave none.
     */
    deletedBy: SoftDeleteActor;
}

/**
 * A row as a hook receives it: the model's columns, plus whatever an earlier hook added (`ends_at`, a count, an
 * uppercase copy) — hooks are where computed columns get attached, so extra keys are allowed.
 */
export type OrmHookRow<X extends OrmModel> = OrmRow<X> & Record<string, unknown>;

/** What an after-hook may give back instead of the rows it was handed. */
export type OrmHookRows<X extends OrmModel> = Array<Partial<OrmRow<X>> & Record<string, unknown>>;

/** The payload a write hook may touch — the columns, not a model instance. */
export type OrmHookPayload<X extends OrmModel> = Partial<OrmRow<X>>;

/**
 * What `beforeInsert` may return: `{ done: row }` when the hook did the insert itself — nothing is written for that
 * row, and `Orm.create()` hands that row back (`afterInsert` still runs). Changing the data needs no return value:
 * the payload *is* the object the hook was handed.
 */
export type OrmInsertIntent = void | undefined | { done: OrmRow<OrmModel>; skipAfterHook?: boolean };

/**
 * What `beforeUpdate` may return: `{ done: row }` when the hook did the write itself, which the mutable path hands
 * back (`afterUpdate` still runs there), or `{ done: count }` on a bulk `updateAll`, where it replaces what the
 * statement would report.
 */
export type OrmUpdateIntent = void | undefined | { done: OrmRow<OrmModel> | number; skipAfterHook?: boolean };

/**
 * A model's hooks. Every one of them is optional, and none has to be async.
 *
 * Declared as methods, so a base model's hook and its subclass' own stay assignable to each other.
 */
export interface OrmHooks<X extends OrmModel> {
    /** Before a read executes — add clauses to the builder; `ctx.phase` says which read this is. */
    beforeRead?<B extends OrmHookBuilder<X>>(builder: B, ctx: OrmReadHookContext): void | Promise<void>;
    /** After a read — reshape the rows in place, or return the rows to use instead. */
    afterRead?(rows: OrmHookRow<X>[], ctx: OrmReadHookContext): void | OrmHookRows<X> | Promise<void | OrmHookRows<X>>;
    /**
     * Before an insert — the payload row, mutable: change it in place (stamp `created_at`, normalise values).
     * `{ done: row }` skips the insert and makes that row the caller's result; `afterInsert` still runs.
     */
    beforeInsert?(row: OrmHookPayload<X>, ctx: OrmHookContext): OrmInsertIntent | Promise<OrmInsertIntent>;
    /**
     * After an insert, with the row as it now is in the database — or the row `beforeInsert` handed back, when it
     * did the insert itself.
     */
    afterInsert?(row: OrmHookRow<X>, ctx: OrmHookContext): void | Promise<void>;
    /**
     * Before an update — the columns about to be written, mutable: change them in place. `{ done }` writes nothing:
     * a row on the mutable path, a count on `updateAll`. On the mutable path `afterUpdate` still runs, and
     * `ctx.original` is the row as it was read.
     */
    beforeUpdate?(row: OrmHookPayload<X>, ctx: OrmUpdateHookContext): OrmUpdateIntent | Promise<OrmUpdateIntent>;
    /**
     * After an update, with the row as it now is in the database — or the row `beforeUpdate` handed back, when it
     * did the write itself.
     */
    afterUpdate?(row: OrmHookRow<X>, ctx: OrmUpdateHookContext): void | Promise<void>;
    /**
     * Before each row is deleted — the row itself: return `false` to keep it, and it is not deleted (the row is a
     * snapshot, so a hook that wants it changed writes that itself). `delete()` reads every row it matches and runs
     * these first, so a hook that throws stops the whole delete before anything is written. `ctx.softDelete` and
     * `ctx.deletedBy` say what the statement is about to do, and for whom.
     */
    beforeDelete?(row: OrmHookRow<X>, ctx: OrmDeleteHookContext): boolean | void | Promise<boolean | void>;
    /** After the statement that removed one row, with that row — a row a hook kept is not reported here. */
    afterDelete?(row: OrmHookRow<X>, ctx: OrmDeleteHookContext): void | Promise<void>;
    /**
     * Before a restore runs — the query that is about to un-mark rows, which the hook may narrow to restore less.
     * Throwing refuses the restore; a restore is ONE statement, so there is no per-row "keep this one" here.
     */
    beforeRestore?<B extends OrmHookBuilder<X>>(builder: B, ctx: OrmHookContext): void | Promise<void>;
    /**
     * After a restore, with the rows that came back — where a model puts back what a delete hook took with it (the
     * entries a soft-deleted author's account delete marked, for instance).
     */
    afterRestore?(rows: OrmHookRow<X>[], ctx: OrmHookContext): void | Promise<void>;
}

type HookFn = (...args: never[]) => unknown;
/** The name of one hook — what `withoutHooks(...)` takes. */
export type OrmHookName = keyof OrmHooks<OrmModel>;
/** The merged view of a model's hooks: one function per name, running the chain in order. */
export type MergedHooks = Partial<Record<OrmHookName, HookFn>>;

const HOOK_NAMES: OrmHookName[] = [
    'beforeRead',
    'afterRead',
    'beforeInsert',
    'afterInsert',
    'beforeUpdate',
    'afterUpdate',
    'beforeDelete',
    'afterDelete',
    'beforeRestore',
    'afterRestore',
];

const hookCache = new WeakMap<object, MergedHooks>();

/** A model's hooks, its base models' hooks included. Cached per model class. */
export function hooksOf(model: OrmModel): MergedHooks {
    const cached = hookCache.get(model);
    if (cached) return cached;

    // Walk the constructor chain, base first.
    const declared: MergedHooks[] = [];
    for (let ctor: unknown = model; typeof ctor === 'function' && ctor !== Function.prototype; ctor = Object.getPrototypeOf(ctor)) {
        const own = (ctor as { hooks?: MergedHooks }).hooks;
        if (own) declared.unshift(own);
    }

    const merged: MergedHooks = {};
    for (const name of HOOK_NAMES) {
        const fns = declared.map((hooks) => hooks[name]).filter((fn): fn is HookFn => typeof fn === 'function');
        if (fns.length === 0) continue;
        // One runner per name, so the dispatch sites never care how many hooks were declared.
        merged[name] = ((...args: unknown[]) => {
            let result: unknown;
            for (const fn of fns) {
                result = (fn as (...a: unknown[]) => unknown)(...args);
            }
            return result;
        }) as HookFn;
    }

    hookCache.set(model, merged);
    return merged;
}

async function runHooks(model: OrmModel, name: OrmHookName, ctx: OrmHookContext, args: unknown[]): Promise<unknown> {
    // A statement may opt out of a hook entirely — see `OrmHookContext.withoutHooks`.
    if (ctx.withoutHooks?.has(name)) return undefined;

    const fn = hooksOf(model)[name];
    if (!fn) return undefined;
    return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
}

/** Runs `beforeRead` — before the SQL is compiled, so the hook can still change the query. */
export function runBeforeRead(model: OrmModel, builder: unknown, ctx: OrmReadHookContext): Promise<unknown> {
    return runHooks(model, 'beforeRead', ctx, [builder, ctx]);
}

/** Runs `afterRead`, letting a hook replace the rows. */
export async function runAfterRead(model: OrmModel, rows: Record<string, unknown>[], ctx: OrmReadHookContext): Promise<void> {
    const replacement = await runHooks(model, 'afterRead', ctx, [rows, ctx]);
    if (Array.isArray(replacement)) rows.splice(0, rows.length, ...replacement);
}

/** Runs `beforeInsert` — the hook changes the payload in place, or hands back the row it inserted. */
export function runBeforeInsert(model: OrmModel, row: unknown, ctx: OrmHookContext): Promise<OrmInsertIntent> {
    return runHooks(model, 'beforeInsert', ctx, [row, ctx]) as Promise<OrmInsertIntent>;
}

export function runAfterInsert(model: OrmModel, row: unknown, ctx: OrmHookContext): Promise<unknown> {
    return runHooks(model, 'afterInsert', ctx, [row, ctx]);
}

/** Runs `beforeUpdate` — the hook changes the payload in place, or hands back what it wrote. */
export function runBeforeUpdate(model: OrmModel, row: unknown, ctx: OrmUpdateHookContext): Promise<OrmUpdateIntent> {
    return runHooks(model, 'beforeUpdate', ctx, [row, ctx]) as Promise<OrmUpdateIntent>;
}

export function runAfterUpdate(model: OrmModel, row: unknown, ctx: OrmUpdateHookContext): Promise<unknown> {
    return runHooks(model, 'afterUpdate', ctx, [row, ctx]);
}

/** Runs `beforeDelete` for one row — `false` keeps the row. */
export function runBeforeDelete(model: OrmModel, row: unknown, ctx: OrmDeleteHookContext): Promise<unknown> {
    return runHooks(model, 'beforeDelete', ctx, [row, ctx]);
}

/** Runs `afterDelete` for one row, after the statement that removed it. */
export function runAfterDelete(model: OrmModel, row: unknown, ctx: OrmDeleteHookContext): Promise<unknown> {
    return runHooks(model, 'afterDelete', ctx, [row, ctx]);
}

/** Runs `beforeRestore` — before the un-delete statement is compiled, so the hook can still narrow it. */
export function runBeforeRestore(model: OrmModel, builder: unknown, ctx: OrmHookContext): Promise<unknown> {
    return runHooks(model, 'beforeRestore', ctx, [builder, ctx]);
}

/** Runs `afterRestore`, with the rows the statement un-marked. */
export function runAfterRestore(model: OrmModel, rows: Record<string, unknown>[], ctx: OrmHookContext): Promise<unknown> {
    return runHooks(model, 'afterRestore', ctx, [rows, ctx]);
}
