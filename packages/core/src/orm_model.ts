/**
 * Model declarations owned by the engine: the `@column` decorator and the store it writes into.
 *
 * This store is the only place a column is declared, and `modelMeta` (in `orm_helpers.ts`) the only reader.
 */
import type { OrmModel } from './orm_model_contract.ts';

/** A column as `@column` declares it. */
export interface OrmColumn {
    /** The property name — the row key and, unless `columnName` overrides it, the DB column. */
    name: string;
    /** The DB column this property maps to. */
    columnName: string;
    isPrimary: boolean;
    /** A cast's `prepare` (e.g. `jsonDec` → a JSON string); the engine's own writes apply it. */
    prepare?: (value: unknown, attribute: string) => unknown;
}

/** The keys `@column` reads as options — `jsonDec`-style casts carry `consume`/`prepare`. */
interface ColumnOptions {
    isPrimary?: boolean;
    columnName?: string;
    /**
     * A cast's read side. The engine never calls it (a read hands the driver's value straight through), so any
     * signature is accepted; it exists so `jsonDec` can be passed, or spread next to the options.
     */
    consume?: (...args: never[]) => unknown;
    /** A cast's write side: applied to a value before an INSERT/UPDATE. */
    prepare?: (value: unknown, attribute: string) => unknown;
}

const columnsByPrototype = new WeakMap<object, Map<string, OrmColumn>>();

/**
 * Declares a model property as a column:
 *
 * ```ts
 * @column() declare title: string
 * @column({ isPrimary: true }) declare id: number
 * @column({ columnName: 'opt1' }) declare opt1: string          // the property name differs from the column
 * @column(jsonDec) declare genres: string[]                     // a cast
 * @column({ ...jsonDec }) declare data: Json                    // options around a cast
 * ```
 *
 * A column kept out of reads is declared in the model's `static hiddenColumns` list, not here: that list is what the
 * types can see (`RowOf`, `withHidden`).
 */
export function column(options?: ColumnOptions): PropertyDecorator {
    return (prototype, propertyKey) => {
        const name = String(propertyKey);
        const opts = options ?? {};
        let columns = columnsByPrototype.get(prototype);
        if (!columns) {
            columns = new Map<string, OrmColumn>();
            columnsByPrototype.set(prototype, columns);
        }
        columns.set(name, {
            name,
            columnName: opts.columnName ?? name,
            isPrimary: !!opts.isPrimary,
            ...(typeof opts.prepare === 'function' ? { prepare: opts.prepare } : {}),
        });
    };
}

/**
 * The columns the model declares through this module's `@column`, base classes first, or `undefined` when it
 * declares none through it (which is how `modelMeta` knows the engine has no metadata for that model).
 */
export function columnsDeclaredByEngine(model: OrmModel): Map<string, OrmColumn> | undefined {
    const chain: object[] = [];
    for (let proto = model.prototype as object | null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        if (columnsByPrototype.has(proto)) chain.unshift(proto);
    }
    if (chain.length === 0) return undefined;

    const merged = new Map<string, OrmColumn>();
    for (const proto of chain) {
        for (const [name, column] of columnsByPrototype.get(proto)!) merged.set(name, column);
    }
    return merged;
}
