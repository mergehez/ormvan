import { isDeepStrictEqual } from 'node:util';
import type { OrmQueryable } from './executor.ts';
import { type BuilderCtor, type ColsOf } from './orm_builder.ts';
import { ormConfig } from './orm_config.ts';
import type { OrmContext } from './orm_context.ts';
import { modelMeta } from './orm_helpers.ts';
import { runAfterUpdate, runBeforeUpdate, type OrmUpdateHookContext } from './orm_hooks.ts';
import {} from './orm_model_base.ts';
import { OrmModel } from './orm_model_contract.ts';
import type { SimpleBuilder } from './orm_simple_builder.ts';

export function objKeys<TKey extends string | number | symbol, TValue, O extends Record<TKey, TValue>>(o: O) {
    return Object.keys(o) as Exclude<keyof O, symbol>[];
}

// type DeepReadonly<T> = T extends Builtin ? T : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
// type Builtin = string | number | boolean | bigint | symbol | undefined | null | Function | Date | RegExp;
export type MutableRowRes<Row> = Row & {
    /** `ctx` lets the save stamp `updated_by`/`updated_at` from the request. */
    save(ctx?: OrmContext): Promise<Row>;
    refresh(): Promise<Row>;
};

export type Mutable<T> = MutableRowRes<T>;

// export type MutableRowRes<Row, X extends OrmModel> = Prettify<
//     {
//         [k in Extract<keyof Row, ColsOf<X>>]: Row[k];
//     } & {
//         readonly [k in Exclude<keyof Row, ColsOf<X>>]: DeepReadonly<Row[k]>;
//     } & {
//         save(): Promise<Row>;
//     }
// >;

// function onlyKeys<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
//     const result: Partial<T> = {};
//     keys.forEach((key) => {
//         if (key in obj) {
//             result[key] = obj[key];
//         }
//     });
//     return result as Pick<T, K>;
// }

/**
 * Whether a column holds the value it was read with.
 *
 * Primitives compare as they are, and nested values compare by shape: the row being written holds copies of
 * what was read (see `createMutableRow`), so `!==` alone would call every JSON column dirty and write it
 * back unchanged. A change made in place is still a change, because the row it is compared against was
 * never touched.
 */
function sameColumnValue(read: unknown, current: unknown): boolean {
    return read === current || isDeepStrictEqual(read, current);
}

/**
 * A copy of a row's nested values, and only those: arrays, plain objects, `Date` and `Buffer` — the shapes a
 * driver hands back for a JSON, date or binary column. Anything else is left alone, because copying it would
 * change what the column holds.
 */
function cloneRowValues<T>(value: T): T {
    if (Array.isArray(value)) return value.map((entry) => cloneRowValues(entry)) as unknown as T;
    if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
    if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
    if (isPlainObject(value)) {
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(value)) copy[key] = cloneRowValues((value as Record<string, unknown>)[key]);
        return copy as T;
    }
    return value;
}

/** Row values are JSON-shaped, so a prototype other than `Object.prototype` means a type of its own. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * A row read through `b` can be saved and re-read: both go through that builder's class, its transaction and its
 * model, so a row makes the same choices the chain that read it did.
 */
export function createMutableRow<Row extends Record<string, any>, X extends OrmModel = OrmModel>(b: SimpleBuilder<X>, pk: ColsOf<X>, rowIn: Row): Mutable<Row> {
    type MutableRow = MutableRowRes<Row>;

    const state = b.__internals();
    const initialRow = rowIn as MutableRow;

    // The row's nested values are copied, and the copy is what makes `save()` trustworthy: an edit made in
    // place — `row.settings.flags.beta = true` — is only a change if the row being edited holds an object of
    // its own to compare against the one that was read. Sharing an object with `initialRow` also breaks what
    // update hooks are promised: `original` is the row as it was read, and it would otherwise be the row as
    // it has just been changed.
    const mutable = cloneRowValues(rowIn) as MutableRow;

    // `save`/`refresh` are the row's API, not its data, so they are non-enumerable: a spread or `Object.keys`
    // gives the row's columns and nothing else.
    Object.defineProperties(mutable, {
        save: {
            configurable: true,
            writable: true,
            value(this: MutableRow, ctx?: OrmContext) {
                return compareAndUpdateOrmRow(b.model, initialRow, this, ctx, state.builderClass, state.client);
            },
        },
        refresh: {
            configurable: true,
            writable: true,
            value: async function (this: MutableRow) {
                // A fresh chain, then the columns are copied onto this row (which keeps its `save`/`refresh`).
                const fresh = new state.builderClass(b.model);
                if (state.client) fresh.__internals().client = state.client;
                const row = await fresh.where(pk, this[pk]).first();
                if (row) Object.assign(this, row);
                return this as Row;
            },
        },
    });

    return mutable;
}

export async function compareAndUpdateOrmRow<X extends OrmModel, Row extends Record<string, any> = any>(
    model: X,
    originalRow: Row,
    updatedRow: any,
    ctx: OrmContext | undefined,
    /** The chain class the row was read through — the update runs on one of its builders. */
    builderClass: BuilderCtor,
    /** The transaction the row was read in, so a hook can join it. */
    client?: OrmQueryable
) {
    const meta = modelMeta(model);
    // `save()` carries the key in the row; `Orm.update(Model, pk, data)` names it beside a partial payload.
    const pkValue = updatedRow[meta.primaryKey] ?? originalRow[meta.primaryKey];
    if (!pkValue) throw new Error(`Missing primary key value for update: ${meta.primaryKey}`);

    const hookCtx: OrmUpdateHookContext = { client, now: () => ormConfig().now(), original: originalRow, isFirstCall: true, isLastCall: true };
    // Before the dirty-column list is computed: the row the hook was handed is the one being written, so a stamp it
    // sets in place is part of the write.
    const intent = await runBeforeUpdate(model, updatedRow, hookCtx);

    // The hook did the write: nothing is written here, and the row it hands back is the caller's result.
    if (intent) {
        const wrapper = new builderClass(model);
        if (client) wrapper.withClient(client);
        if (!intent.skipAfterHook) await runAfterUpdate(model, intent.done, hookCtx);
        return createMutableRow(wrapper, meta.primaryKey as ColsOf<X>, intent.done as Row);
    }
    const mutableColumns = meta.columns;
    const dirtyColumns = objKeys(updatedRow)
        .map(String)
        .filter((key) => mutableColumns.includes(key) && !sameColumnValue(updatedRow[key], originalRow[key]));

    if (dirtyColumns.length === 0) {
        console.log(`No dirty columns for ${meta.table}.${meta.primaryKey}: ${pkValue}`);
        return updatedRow; // nothing to save
    }

    // The `updated_at`/`updated_by` a request context asks for, on top of the hook's own stamps.
    if (ctx) {
        if (mutableColumns.includes('updated_at') && !dirtyColumns.includes('updated_at')) {
            updatedRow.updated_at = ormConfig().now();
            dirtyColumns.push('updated_at');
        }
        const auth = ormConfig().getAuthUser(ctx);
        if (mutableColumns.includes('updated_by') && auth && !dirtyColumns.includes('updated_by')) {
            updatedRow.updated_by = auth.id;
            dirtyColumns.push('updated_by');
        }
    }

    // console.log('Updating row with dirty columns:', dirtyColumns, onlyKeys(originalRow, dirtyColumns), onlyKeys(updatedRow, dirtyColumns).table);

    // The engine's own UPDATE: only the dirty columns, the request stamps included.
    const builder = new builderClass(model);
    if (client) builder.withClient(client);

    const payload: Record<string, any> = {};
    for (const key of dirtyColumns) payload[key] = updatedRow[key] ?? null;
    await builder.update(pkValue, payload);

    const saved = (await builder.where(meta.primaryKey as ColsOf<X>, pkValue).first()) ?? (updatedRow as Record<string, unknown>);
    await runAfterUpdate(model, saved, hookCtx);
    return saved as Row;
}
