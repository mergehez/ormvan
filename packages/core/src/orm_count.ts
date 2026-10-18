import type { CountSpec, WhereClause } from './orm_helpers.ts';
import { modelHelpers as helpers, modelTable } from './orm_helpers.ts';
import { OrmModel } from './orm_model_contract.ts';
import type { OrmRelationContract } from './orm_relations.ts';

/**
 * What a count callback can call, as the count ENGINE sees it. Structural and loose on purpose: a helper whose
 * model parameter is generic cannot name the relation's child columns, so the columns here are plain strings. The
 * runtime object is the `CountQueryBuilder` the engine spawns for the callback.
 */
export interface CountSubquery {
    /** The alias `.as(...)` set — the count column's name, or `null` for the default `<relation>_count`. */
    countAlias: string | null;
    where(column: string | { sql: string }, operatorOrValue: unknown, value?: unknown): CountSubquery;
    whereNull(column: string | { sql: string }): CountSubquery;
    whereNotNull(column: string | { sql: string }): CountSubquery;
    whereRaw(sql: string, bindings?: unknown[]): CountSubquery;
    /** Renames the count column; returns the alias so the row type tracks it. */
    as<A extends string>(alias: A): A;
}

/**
 * The alias a count carries: the callback's `.as(...)`, or the alias string it returned, else `null` — the default
 * `<relation>_count`.
 */
export function countAliasOf(cbOrAlias: unknown, subquery: CountSubquery, returned: unknown): string | null {
    if (typeof cbOrAlias === 'string') return cbOrAlias;
    return subquery.countAlias ?? (typeof returned === 'string' ? returned : null);
}

/**
 * Joins a callback's clauses with their own connectors. Parenthesized when one is ORed, or that OR would escape the
 * condition it is ANDed to (the correlation, or another filter) and match rows it should not.
 */
function joinClauses(clauses: WhereClause[]): string {
    const joined = clauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ');
    return clauses.some((w) => w.boolean === 'OR') ? `(${joined})` : joined;
}

/** The ORM-specific behaviors the count engine needs but cannot provide itself. */
export interface OrmCountDeps {
    relationOnQuery: (relation: OrmRelationContract) => WhereClause[];
}

/** The count engine: pure algorithms (spec record + SQL compile). Stateless. */
export class OrmCount {
    private specs: CountSpec[] = [];

    public constructor(public deps: OrmCountDeps) {}

    /** The recorded count specs (owned by this engine). */
    public all(): CountSpec[] {
        return this.specs;
    }

    /** Replaces the whole spec list (used when re-hydrating a captured sub-builder). */
    public replaceAll(counts: CountSpec[]): void {
        this.specs = [...counts];
    }

    /**
     * Records a count: `alias` is its column name (`null` for `<relation>_count`), `clauses` the WHERE the
     * callback collected on the count subquery, and `includeSoftDelete` that subquery's own soft-delete state.
     */
    public add(relationName: string, alias: string | null = null, clauses: WhereClause[] = [], includeSoftDelete = true): CountSpec {
        const spec: CountSpec = { relationName, alias, extra: clauses, includeSoftDelete };
        this.specs.push(spec);
        return spec;
    }

    /**
     * Compiles every recorded count into a `(SELECT COUNT(*) ...) AS <alias>` fragment, for the main query's
     * SELECT list.
     */
    public compileAll(parentModel: OrmModel, parentTable: string, bindings: any[]): string[] {
        return this.specs.map((count) => {
            const relation = helpers.getRelationFor(parentModel, count.relationName);
            const childAlias = modelTable(relation.relatedModel()) === parentTable ? count.relationName : undefined;
            return this.compileCountSql(parentModel, parentTable, count, bindings, true, childAlias);
        });
    }

    /**
     * Compiles every recorded count into `'<alias>', (SELECT COUNT(*) ...)` JSON key/value pairs, for nesting
     * inside a preload's JSON_OBJECT.
     */
    public compileJsonKeys(parentModel: OrmModel, parentTable: string, bindings: any[], childAlias?: string): string[] {
        return this.specs.map((count) => {
            const as = count.alias ?? `${count.relationName}_count`;
            return `'${as}', ${this.compileCountSql(parentModel, parentTable, count, bindings, false, childAlias)}`;
        });
    }

    /**
     * Compiles one count subquery against `parentModel`/`parentTable`.
     */
    public compileCountSql(parentModel: OrmModel, parentTable: string, count: CountSpec, bindings: any[], asAlias = true, childAlias?: string): string {
        const relation = helpers.getRelationFor(parentModel, count.relationName);

        let sub = `(SELECT COUNT(*) ${helpers.relationFromWhere(relation, parentTable, parentModel, childAlias, count.includeSoftDelete)}`;

        // The relation's own onQuery filters — applied so a count matches what the relation returns.
        const filters = this.deps.relationOnQuery(relation);
        if (filters.length > 0) {
            sub += ` AND ${joinClauses(filters)}`;
            bindings.push(...filters.flatMap((f) => f.bindings));
        }
        if (count.extra.length > 0) {
            sub += ` AND ${joinClauses(count.extra)}`;
            bindings.push(...count.extra.flatMap((w) => w.bindings));
        }
        const alias = count.alias ?? `${count.relationName}_count`;
        return asAlias ? `${sub}) AS ${alias}` : `${sub})`;
    }
}
