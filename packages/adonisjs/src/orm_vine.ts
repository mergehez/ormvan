/**
 * The `exists` / `unique` VineJS rules, on the engine's connection:
 *
 * ```ts
 * vine.number().exists({ table: 'users', column: 'id' });
 * ```
 *
 * Registration is explicit — an app calls this once at boot.
 */
import vine, { VineNumber, VineString } from '@vinejs/vine';
import type { FieldContext } from '@vinejs/vine/types';
import type { OrmQueryable } from '@mergehez/ormvan';
import { limitOffset, quoteId } from '@mergehez/ormvan/orm_sql';
import type { SqlValue } from '@mergehez/ormvan/orm_where';
import './context.ts';

/** Reported by VineJS — user-visible strings, so they do not change. */
export const messages = {
    'database.unique': 'The {{ field }} has already been taken',
    'database.exists': 'The selected {{ field }} is invalid',
};

export interface OrmVineSearchOptions {
    /** The table to search, as the model spells it (`Post.table`). */
    table: string;
    /** Defaults to the field's own name, so a field called `title` searches `table.title`. */
    column?: string;
    /**
     * Narrows the search with anything the rule cannot say itself, as a raw fragment:
     * `filter: (_, field) => dbRaw('`id` <> ?', [field.meta?.params?.id])`.
     */
    filter?: (value: unknown, field: FieldContext) => SqlValue | undefined | void;
}

/** The methods this module adds to a schema type — one shape for both `VineString` and `VineNumber`. */
interface OrmVineBindings {
    /** Fails when a row with this value already exists. */
    unique(options: OrmVineSearchOptions): this;
    /** Fails when no row with this value exists. */
    exists(options: OrmVineSearchOptions): this;
}

// The augmentation lives here rather than in a `.d.ts`: an app that imports this module (which it must, to
// register the rules) gets the types with it.
declare module '@vinejs/vine' {
    interface VineString extends OrmVineBindings {}
    interface VineNumber extends OrmVineBindings {}
}

/** Runs the rule's statement and answers whether a matching row is there. */
async function hasRow(queryable: () => OrmQueryable, options: OrmVineSearchOptions, value: unknown, field: FieldContext): Promise<boolean> {
    const column = options.column ?? String(field.name);
    const extra = options.filter?.(value, field);
    const where = [`${quoteId(column)} = ?`];
    // One flat binding list, the rule's own value first — the same order the engine keeps everywhere else.
    const bindings: unknown[] = [value];

    if (extra) {
        where.push(`(${extra.sql})`);
        bindings.push(...(extra.bindings ?? []));
    }

    const rows = await queryable().query(`SELECT 1 FROM ${quoteId(options.table)} WHERE ${where.join(' AND ')}${limitOffset(1)}`, bindings);

    return rows.length > 0;
}

/**
 * The parts of an app's VineJS an app passes in when the engine is not what resolves `@vinejs/vine` for it — a
 * linked engine ships its own copy, and rules registered on THAT copy would leave the app's schemas without them.
 * Pass the app's own module: `{ vine, VineString, VineNumber }`.
 */
export interface OrmVineApis {
    vine: typeof import('@vinejs/vine').default;
    VineString: typeof import('@vinejs/vine').VineString;
    VineNumber: typeof import('@vinejs/vine').VineNumber;
}

/**
 * Teaches VineJS the two rules, backed by `queryable` (an app passes `() => Orm.getExecutor()`). Called from a
 * provider's `boot()`, with the app's own VineJS when it has one.
 */
export function defineOrmValidationRules(queryable: () => OrmQueryable, apis: OrmVineApis = { vine, VineString, VineNumber }): void {
    const { vine: vineInstance, VineString: StringType, VineNumber: NumberType } = apis;

    const uniqueRule = vineInstance.createRule<OrmVineSearchOptions>(
        async (value, options, field) => {
            // Another rule already rejected this field; reporting a second message for the same value helps nobody.
            if (!field.isValid) return;

            if (await hasRow(queryable, options, value, field)) {
                field.report(messages['database.unique'], 'database.unique', field);
            }
        },
        { name: 'unique', isAsync: true }
    );

    const existsRule = vineInstance.createRule<OrmVineSearchOptions>(
        async (value, options, field) => {
            if (!field.isValid) return;

            if (!(await hasRow(queryable, options, value, field))) {
                field.report(messages['database.exists'], 'database.exists', field);
            }
        },
        { name: 'exists', isAsync: true }
    );

    // A provider can boot twice in one process, so the registration checks the name it is about to add.
    if (!('unique' in StringType.prototype)) {
        StringType.macro('unique', function (this: VineString, options: OrmVineSearchOptions) {
            return this.use(uniqueRule(options));
        });
        StringType.macro('exists', function (this: VineString, options: OrmVineSearchOptions) {
            return this.use(existsRule(options));
        });
    }

    if (!('unique' in NumberType.prototype)) {
        NumberType.macro('unique', function (this: VineNumber, options: OrmVineSearchOptions) {
            return this.use(uniqueRule(options));
        });
        NumberType.macro('exists', function (this: VineNumber, options: OrmVineSearchOptions) {
            return this.use(existsRule(options));
        });
    }
}
