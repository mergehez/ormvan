import { OrmSoftDeleteMisconfiguredError } from './orm_errors.ts';
import { hooksOf, type OrmHookName } from './orm_hooks.ts';
import { columnsDeclaredByEngine } from './orm_model.ts';
import { OrmModel } from './orm_model_contract.ts';
import type { OrmRelationContract } from './orm_relations.ts';
import { relationsDeclaredByEngine } from './orm_relations.ts';
import { activeRowSql, softDeleteOf, type SoftDeleteConfig } from './orm_soft_delete.ts';
import { limitOffset } from './orm_sql.ts';

/** A key is absent-capable iff it was declared optional (`?:`) on the model. */
type OptionalKeys<Obj> = {
    [K in keyof Obj]-?: {} extends Pick<Obj, K> ? K : never;
}[keyof Obj];

/** What a column holds in a row: a NULL column reads `null`, never `undefined`. */
type RowValue<T> = undefined extends T ? Exclude<T, undefined> | null : T;

/** An absent-capable key: the `?` already means "absent", so its value never says `undefined`. */
type OptionalValue<T> = Exclude<T, undefined>;

/**
 * Row shape, generated from the model:
 *  - a key declared optional (`?:`) is optional, and its value never mentions `undefined`;
 *  - every other key is ALWAYS present, and a nullable column reads `null` — never `undefined`.
 */
export type ConvertNullable<Obj> = {
    [K in keyof Obj as K extends OptionalKeys<Obj> ? K : never]?: OptionalValue<Obj[K]>;
} & {
    [K in keyof Obj as K extends OptionalKeys<Obj> ? never : K]: RowValue<Obj[K]>;
};

export type RawSqlSubquery = { sql: string; bindings?: unknown[] };

export type SqlSubquery = {
    toSQL(): RawSqlSubquery;
};
export type WhereClause = { sql: string; boolean: 'AND' | 'OR'; bindings: any[] };
export type JoinClause = { sql: string; bindings: any[] };
/**
 * One recorded count: the relation, the column alias (`null` for `<relation>_count`), the WHERE the callback
 * collected — and the child's own soft-delete decision, which travels with the count because the callback made it.
 */
export type CountSpec = { relationName: string; alias: string | null; extra: WhereClause[]; includeSoftDelete: boolean };

export const dbRaw = (sql: string, bindings: readonly unknown[] = []) => ({ sql, bindings });

/**
 * Everything the engine reads off a model: the table, its columns, its soft-delete config, whether it has delete
 * hooks, and the per-column casts.
 */
export interface OrmModelMeta {
    /** The table rows are read from and written to. */
    table: string;
    primaryKey: string;
    /** Column property names, in declaration order — what a default projection selects. */
    columns: readonly string[];
    /** Property name → DB column name (they differ only for a column with an explicit `columnName`). */
    columnNames: ReadonlyMap<string, string>;
    /** A `deleted_at` column is declared ⇒ the soft-delete scope applies. */
    isSoftDeletable: boolean;
    /**
     * The model's soft delete, or `undefined`. Absent by default: a model that declares a `deleted_at` column but
     * no config has NONE.
     */
    softDelete?: SoftDeleteConfig;
    /** A `beforeDelete`/`afterDelete` hook is declared ⇒ a delete walks its rows. */
    deleteHooks: readonly OrmHookName[];
    /** A `beforeRestore`/`afterRestore` hook is declared ⇒ `restore()` runs it (and reads the rows when it must). */
    restoreHooks: readonly OrmHookName[];
    /**
     * Column → the `prepare` its cast declares (`@column(jsonDec)` → a JSON string). The engine's own
     * INSERT/UPDATE applies these, so a raw write stores what the cast says it should.
     */
    castPrepare: ReadonlyMap<string, (value: unknown, attribute: string) => unknown>;
}

const metaCache = new WeakMap<object, OrmModelMeta>();

/**
 * The model's table name. A model that does not spell out `static table` needs booting first, or the query runs
 * as `FROM undefined`.
 */
export function modelTable(model: OrmModel): string {
    if (!model.table) {
        try {
            // Boot defines `table` first, before it walks relations, so a boot that throws later still leaves
            // the name behind — the same guarantee `modelMeta` relies on.
            model.boot();
        } catch {
            // ignored: see above, plus `modelMeta`'s note about relations referencing unloaded code
        }
    }
    return model.table ?? model.namingStrategy.tableName(model);
}

/** The model's metadata, booting it first when needed — the one accessor for a model's internals. */
export function modelMeta<X extends OrmModel>(model: X): OrmModelMeta {
    const cached = metaCache.get(model);
    if (cached) return cached;

    if (!model.booted) {
        try {
            model.boot();
        } catch {
            // Booting fails for a model whose relations reference code that isn't loaded; the column
            // definitions are registered by then, and they are all this needs.
        }
    }

    const engineColumns = columnsDeclaredByEngine(model);

    const columnNames = new Map<string, string>();
    const castPrepare = new Map<string, (value: unknown, attribute: string) => unknown>();

    // The columns the model declares with `@column` (`orm_model.ts`), base classes first — the order they are
    // projected in, and the only column store there is.
    let enginePrimaryKey: string | undefined;
    for (const [name, definition] of engineColumns ?? []) {
        columnNames.set(name, definition.columnName);
        if (definition.isPrimary) enginePrimaryKey = name;
        if (definition.prepare) castPrepare.set(name, definition.prepare);
    }

    // The model's own soft delete, if it has one: nothing is inferred from a column name here.
    const softDelete = softDeleteOf(model);
    if (softDelete && ![...columnNames.values()].includes(softDelete.column)) {
        throw new OrmSoftDeleteMisconfiguredError(model, softDelete.column, [...columnNames.values()]);
    }

    const meta: OrmModelMeta = {
        table: modelTable(model),
        primaryKey: enginePrimaryKey ?? (model.primaryKey as string),
        columns: [...columnNames.keys()],
        columnNames,
        isSoftDeletable: softDelete !== undefined,
        ...(softDelete ? { softDelete } : {}),
        deleteHooks: deleteHooksOf(model),
        restoreHooks: restoreHooksOf(model),
        castPrepare,
    };

    metaCache.set(model, meta);
    return meta;
}

/** The delete hooks a model may declare, in the order a message should name them. */
const DELETE_HOOK_NAMES: OrmHookName[] = ['beforeDelete', 'afterDelete'];

/** The restore hooks, same idea. */
const RESTORE_HOOK_NAMES: OrmHookName[] = ['beforeRestore', 'afterRestore'];

/**
 * The delete hooks the model — or one of its base models — declares. A delete that has any walks its rows, so each
 * hook sees the row it is about to remove.
 */
function deleteHooksOf(model: OrmModel): OrmHookName[] {
    return hooksDeclared(model, DELETE_HOOK_NAMES);
}

/** The restore hooks the model declares — a restore that has any runs them, and reads its rows when it must. */
function restoreHooksOf(model: OrmModel): OrmHookName[] {
    return hooksDeclared(model, RESTORE_HOOK_NAMES);
}

function hooksDeclared(model: OrmModel, names: OrmHookName[]): OrmHookName[] {
    const hooks = hooksOf(model);
    return names.filter((name) => typeof hooks[name] === 'function');
}

export const modelHelpers = {
    isSoftDeletable(targetModel: OrmModel) {
        return modelMeta(targetModel).isSoftDeletable;
    },
    /**
     * The live-row predicate for one table reference (`<ref>.deleted_at IS NULL`), or `null` when the
     * model has no soft delete — the one place the engine turns a config into SQL for a read.
     */
    softDeleteScope(targetModel: OrmModel, ref: string): string | null {
        const config = modelMeta(targetModel).softDelete;
        return config ? activeRowSql(config, ref) : null;
    },
    /** ` AND <live-row predicate>` for a relation subquery, or `''` — appended only when the caller's
     * `withTrashed()` did not drop the scope (`includeSoftDelete`).
     */
    softDeleteJoin(targetModel: OrmModel, ref: string): string {
        const scope = this.softDeleteScope(targetModel, ref);
        return scope ? ` AND ${scope}` : '';
    },
    hasDeleteHooks(targetModel: OrmModel) {
        return modelMeta(targetModel).deleteHooks.length > 0;
    },
    /** The delete hooks the model declares — what a delete needs to see skipped before it walks rows. */
    deleteHooks(targetModel: OrmModel): readonly OrmHookName[] {
        return modelMeta(targetModel).deleteHooks;
    },
    /** The restore hooks the model declares — what `restore()` needs to see skipped before it reads rows. */
    restoreHooks(targetModel: OrmModel): readonly OrmHookName[] {
        return modelMeta(targetModel).restoreHooks;
    },

    // Generates the `'_col_', col` argument pairs for a JSON_OBJECT (base columns only). A `expr AS alias`
    // fragment is emitted as `'alias', expr` — MySQL rejects an inner `AS` inside JSON_OBJECT.
    jsonObjectArgs(targetModel: OrmModel, tableAlias: string, columns?: string[]) {
        const cols = columns ?? modelMeta(targetModel).columns;
        return cols.map((col) => {
            const asIdx = col.toUpperCase().lastIndexOf(' AS ');
            if (asIdx !== -1) {
                const expr = col.slice(0, asIdx).trim();
                const as = col.slice(asIdx + 4).trim();
                return `'${as}', ${expr}`;
            }
            return `'${col}', ${tableAlias}.${col}`;
        });
    },
    /**
     * Renders the trailing GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET clauses, plus their bindings.
     */
    renderTailClauses(
        groupBy: string[],
        havings: { sql: string; bindings: any[] }[],
        orderBy: { sql: string; bindings: any[] }[],
        limit?: number,
        offset?: number
    ): { sql: string; bindings: any[] } {
        let sql = '';
        const bindings: any[] = [];
        if (groupBy.length > 0) sql += ` GROUP BY ${groupBy.join(', ')}`;
        if (havings.length > 0) {
            sql += ` HAVING ${havings.map((h) => h.sql).join(' AND ')}`;
            bindings.push(...havings.flatMap((h) => h.bindings));
        }
        if (orderBy.length > 0) {
            sql += ` ORDER BY ${orderBy.map((o) => o.sql).join(', ')}`;
            bindings.push(...orderBy.flatMap((o) => o.bindings));
        }
        if (limit || offset) sql += limitOffset(limit, offset);
        return { sql, bindings };
    },

    /** Returns the model's relation by name, booting the model first (a relation factory may need its table). */
    getRelationFor(model: OrmModel, relationName: string) {
        modelMeta(model);

        // The relation declared with `@ormHasMany`/`@ormBelongsTo`/…, bound to THIS model so a relation callback
        // can read `this.model`.
        const relation = relationsDeclaredByEngine(model)?.get(relationName);
        if (!relation) {
            throw new Error(`Relation '${relationName}' is not defined on model ${model.name}`);
        }
        return relation;
    },
    /**
     * Resolves the join keys (`localKey`/`foreignKey`) for a relation.
     */
    getRelationKeys(relation: OrmRelationContract, parentModel: OrmModel) {
        if (!relation.booted && 'boot' in relation) {
            try {
                relation.boot();
            } catch {
                // fall through to option-based derivation
            }
        }

        const rel = relation as {
            localKey?: string;
            foreignKey?: string;
            localKeyColumnName?: string;
            foreignKeyColumnName?: string;
            options?: { localKey?: string; foreignKey?: string };
        };
        if ('foreignKey' in relation && (rel.localKeyColumnName || rel.localKey) && (rel.foreignKeyColumnName || rel.foreignKey)) {
            return {
                localKey: rel.localKeyColumnName ?? rel.localKey!,
                foreignKey: rel.foreignKeyColumnName ?? rel.foreignKey!,
            };
        }

        const options = rel.options ?? {};
        const related = relation.relatedModel();
        const parentPrimary = parentModel.primaryKey ?? 'id';
        const relatedPrimary = related?.primaryKey ?? 'id';

        // Default FK is `<relationName>_id`, used only when a relation omits an explicit `foreignKey`.
        return {
            localKey: options.localKey ?? (relation.type === 'belongsTo' ? relatedPrimary : parentPrimary),
            foreignKey: options.foreignKey ?? `${relation.relationName}_id`,
        };
    },

    /**
     * Builds the `FROM ... WHERE <join condition>` fragment for a relation subquery (preload / count / whereHas),
     * with the child's soft-delete scope applied unless the sub-builder called `withTrashed()`.
     *
     * `joins` are the caller's own `JOIN` clauses (a preload callback's), placed after the fragment's own joins.
     */
    relationFromWhere(relation: OrmRelationContract, parentTable: string, parentModel: OrmModel, childAlias?: string, includeSoftDelete = true, joins: readonly string[] = []) {
        const joinSql = joins.length ? ` ${joins.join(' ')}` : '';
        const relatedModel = relation.relatedModel();
        const table = modelTable(relatedModel);
        // `childAlias` lets a self-referencing relation reference its own table under a
        // different name so the subquery doesn't collide with the outer table. Emit
        // `FROM <table> as <alias>` (and reference columns via the alias).
        const childTable = childAlias && childAlias !== table ? `${table} as ${childAlias}` : table;
        const childRef = childAlias && childAlias !== table ? childAlias : table; // the reference used to qualify child columns

        if (relation.type === 'manyToMany') {
            const { pivotTable, localKey, relatedKey, pivotForeignKey, pivotRelatedForeignKey } = getManyToManyKeys(relation, parentModel);
            let s = `FROM ${childTable} INNER JOIN ${pivotTable} ON ${pivotTable}.${pivotRelatedForeignKey} = ${childRef}.${relatedKey}`;
            s += `${joinSql} WHERE ${pivotTable}.${pivotForeignKey} = ${parentTable}.${localKey}`;
            if (includeSoftDelete) s += modelHelpers.softDeleteJoin(relatedModel, childRef);
            return s;
        }

        if (relation.type === 'hasManyThrough') {
            const { throughTable, localKey, foreignKey, throughLocalKey, throughForeignKey, throughModel } = getThroughKeys(relation, parentModel);
            let s = `FROM ${childTable} INNER JOIN ${throughTable} ON ${throughTable}.${throughLocalKey} = ${childRef}.${throughForeignKey}`;
            s += `${joinSql} WHERE ${throughTable}.${foreignKey} = ${parentTable}.${localKey}`;
            if (includeSoftDelete && throughModel) s += modelHelpers.softDeleteJoin(throughModel, throughTable);
            if (includeSoftDelete) s += modelHelpers.softDeleteJoin(relatedModel, childRef);
            return s;
        }

        const { localKey, foreignKey } = modelHelpers.getRelationKeys(relation, parentModel);
        const parentCol = relation.type === 'belongsTo' ? foreignKey : localKey;
        const childCol = relation.type === 'belongsTo' ? localKey : foreignKey;
        let s = `FROM ${childTable}${joinSql} WHERE ${childRef}.${childCol} = ${parentTable}.${parentCol}`;
        if (includeSoftDelete) s += modelHelpers.softDeleteJoin(relatedModel, childRef);
        return s;
    },
};

/**
 * Resolves hasManyThrough join metadata: the through table, the through table's FK to the parent (`foreignKey`),
 * the parent PK (`localKey`), the through PK (`throughLocalKey`) and the related table's FK back to the through PK
 * (`throughForeignKey`). Prefers the resolved `...ColumnName` accessors.
 */
function getThroughKeys(relation: OrmRelationContract, parentModel: OrmModel) {
    // Boot first (like getRelationKeys) so the `localKeyColumnName`/`throughLocalKeyColumnName`/… accessors exist.
    if (!relation.booted && 'boot' in relation) {
        try {
            relation.boot();
        } catch {
            // fall through to option-based derivation
        }
    }
    const rel = relation as OrmRelationContract & { throughModel: () => OrmModel };
    // Call it ON the relation: `OrmRelation` implements `throughModel` as a METHOD, so a detached call loses
    // `this` and `this.#through` throws.
    const throughModel = rel.throughModel ? rel.throughModel() : (rel.options?.throughModel?.() ?? null);
    return {
        throughTable: throughModel ? modelTable(throughModel) : '',
        localKey: rel.localKeyColumnName ?? rel.localKey ?? parentModel.primaryKey ?? 'id',
        foreignKey: rel.foreignKeyColumnName ?? rel.foreignKey ?? '',
        throughLocalKey: rel.throughLocalKeyColumnName ?? rel.throughLocalKey ?? 'id',
        throughForeignKey: rel.throughForeignKeyColumnName ?? rel.throughForeignKey ?? 'id',
        throughModel,
    };
}
/**
 * Resolves manyToMany pivot join metadata: the pivot table, the parent's PK (`localKey`), the pivot's FK back to
 * it (`pivotForeignKey`), the related model's PK (`relatedKey`) and the pivot's FK to it
 * (`pivotRelatedForeignKey`). Prefers the resolved `...ColumnName` accessors.
 */
function getManyToManyKeys(relation: OrmRelationContract, parentModel: OrmModel) {
    if (!relation.booted && 'boot' in relation) {
        try {
            relation.boot();
        } catch {
            // fall through to option-based derivation
        }
    }
    const rel = relation as OrmRelationContract;
    const related = relation.relatedModel();
    return {
        pivotTable: rel.pivotTable ?? rel.options?.pivotTable ?? '',
        localKey: rel.localKeyColumnName ?? rel.localKey ?? parentModel.primaryKey ?? 'id',
        relatedKey: rel.relatedKeyColumnName ?? rel.relatedKey ?? related?.primaryKey ?? 'id',
        pivotForeignKey: rel.pivotForeignKey ?? rel.options?.pivotForeignKey ?? '',
        pivotRelatedForeignKey: rel.pivotRelatedForeignKey ?? rel.options?.pivotRelatedForeignKey ?? '',
    };
}
