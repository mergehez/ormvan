import type { OrmBuilderState } from './orm_builder_state.ts';
import type { WhereClause } from './orm_helpers.ts';
import { modelHelpers as helpers } from './orm_helpers.ts';
import { OrmModel } from './orm_model_contract.ts';
import type { OrmRelationContract } from './orm_relations.ts';
import type { SimpleBuilder } from './orm_simple_builder.ts';

type SqlSubquery = { toSQL(): { sql: string; bindings?: unknown[] } };

/**
 * A where-value that belongs in the SQL itself instead of a `?`: a reference to another row's column
 * (`q.ref('user_id')` in a write callback) or `dbRaw(...)`.
 */
export type SqlValue = { sql: string; bindings?: readonly unknown[] };

/** Is this value SQL to inline, rather than something to bind? */
export const isSqlValue = (value: unknown): value is SqlValue =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'sql' in value && typeof value.sql === 'string';

/** A builder (or anything that compiles to one) used as a value — a value the database computes. */
export type SubqueryLike = { toSQL(): { sql: string; bindings?: unknown[] } };

/** Is this value a builder, to be compiled into a scalar subquery? */
export const isSubqueryBuilder = (value: unknown): value is SubqueryLike =>
    typeof value === 'object' && value !== null && 'toSQL' in value && typeof value.toSQL === 'function' && !isSqlValue(value);

/** The ORM-specific behaviors the where engine needs but cannot provide itself. */
interface OrmWhereDeps {
    /** Build a fresh sub-builder on the given model. */
    makeBuilder<M extends OrmModel>(model: M): SimpleBuilder<M>;
    /**
     * The builder a `whereHas` callback is handed: the WHERE family, which is all `EXISTS (SELECT 1 …)` reads. Its own
     * class, so the object matches the `RelationQuery` its callback parameter is typed with.
     */
    spawnWhereHas<M extends OrmModel>(model: M): SimpleBuilder<M>;
    /** A fresh builder of the same flavour as `b` — a grouped WHERE collects clauses and nothing else. */
    spawnLike<M extends OrmModel>(b: SimpleBuilder<M>): SimpleBuilder<M>;
    /** Run a relation's `onQuery` callback against a sub-builder and return its WHERE clauses. */
    relationOnQuery: (relation: OrmRelationContract) => WhereClause[];
}

/** Renders a column ref: bare columns get the table prefix; already-qualified and raw refs pass through. */
function colRef(tableName: string, column: string | { sql: string }): string {
    if (typeof column !== 'string') return column.sql;
    return column.includes('.') ? column : `${tableName}.${column}`;
}

// The where engine: pure clause recorders. Owns the `wheres` array.
export class OrmWhere {
    private clauses: WhereClause[] = [];

    public constructor(public deps: OrmWhereDeps) {}

    /** The recorded WHERE clauses (owned by this engine). */
    public all(): WhereClause[] {
        return this.clauses;
    }

    /** Replaces the whole clause list (used when re-hydrating a captured sub-builder). */
    public replaceAll(wheres: WhereClause[]): void {
        this.clauses = [...wheres];
    }

    private push(clause: WhereClause): void {
        this.clauses.push(clause);
    }

    /** Appends a raw clause (used by `related()` and late-preload IN filters). */
    public addRaw(sql: string, bindings: any[], boolean: 'AND' | 'OR' = 'AND'): void {
        this.push({ sql, boolean, bindings });
    }

    /** All bindings across the recorded clauses, in order. */
    public bindings(): any[] {
        return this.clauses.flatMap((w) => w.bindings);
    }

    /**
     * Joins the recorded clauses with their AND/OR connectors, prepending the model's soft-delete scope unless
     * disabled. Returns null when there are no clauses and no scope.
     */
    public compileWhere(tableName: string, model: OrmModel, enableSoftDeleteGuard: boolean): string | null {
        const softDeleteScope = enableSoftDeleteGuard ? helpers.softDeleteScope(model, tableName) : null;
        if (this.clauses.length === 0) {
            return softDeleteScope;
        }
        const joined = this.clauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ');
        if (softDeleteScope) {
            return `${softDeleteScope} AND (${joined})`;
        }
        return joined;
    }

    /** Joins the recorded clauses with their AND/OR connectors (no soft-delete scope). */
    public compileWhereClauses(): string | null {
        if (this.clauses.length === 0) return null;
        return this.clauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ');
    }

    /** ANDs/ORs `col op value` (default `=` when only a value is given). */
    public where(b: OrmBuilderState, column: string | { sql: string }, operator: any, value?: any, boolean: 'AND' | 'OR' = 'AND'): void {
        const colStr = colRef(b.tableName, column);
        if (value === undefined) {
            value = operator;
            operator = '=';
        }
        if (isSqlValue(value)) {
            // An expression or a reference to another row's column: there is no `?` to bind it to.
            this.push({ sql: `${colStr} ${operator} ${value.sql}`, boolean, bindings: [...(value.bindings ?? [])] });
            return;
        }
        const bindings = Array.isArray(value) ? [...value] : [value];
        this.push({ sql: `${colStr} ${operator} ?`, boolean, bindings });
    }

    /** ANDs a negated-equality clause: `column != value`. */
    public whereNot(b: OrmBuilderState, column: string | { sql: string }, value: any): void {
        if (isSqlValue(value)) {
            this.push({ sql: `${colRef(b.tableName, column)} != ${value.sql}`, boolean: 'AND', bindings: [...(value.bindings ?? [])] });
            return;
        }
        this.push({ sql: `${colRef(b.tableName, column)} != ?`, boolean: 'AND', bindings: [value] });
    }

    /** ANDs a raw WHERE fragment — nothing to qualify, so it needs no receiver. */
    public whereRaw(sql: string, bindings?: any[]): void {
        this.push({ sql, boolean: 'AND', bindings: bindings ?? [] });
    }

    /** ANDs `column IS NULL`. */
    public whereNull(b: OrmBuilderState, column: string | { sql: string }): void {
        this.push({ sql: `${colRef(b.tableName, column)} IS NULL`, boolean: 'AND', bindings: [] });
    }

    /** ANDs `column IS NOT NULL`. */
    public whereNotNull(b: OrmBuilderState, column: string | { sql: string }): void {
        this.push({ sql: `${colRef(b.tableName, column)} IS NOT NULL`, boolean: 'AND', bindings: [] });
    }

    /** ANDs `column IN (...)`; empty list → `IN (NULL)`; also accepts a builder subquery. */
    public whereIn(b: OrmBuilderState, column: string | { sql: string }, values: readonly unknown[] | SqlSubquery): void {
        const colStr = colRef(b.tableName, column);
        if (Array.isArray(values)) {
            if (values.length === 0) return;
            const parts = values.map((v) => (isSqlValue(v) ? v.sql : '?'));
            const bindings = values.flatMap((v) => (isSqlValue(v) ? [...(v.bindings ?? [])] : [v]));
            this.push({ sql: `${colStr} IN (${parts.join(', ')})`, boolean: 'AND', bindings });
            return;
        }
        const { sql: subSql, bindings: subBindings } = (values as SqlSubquery).toSQL();
        this.push({ sql: `${colStr} IN (${subSql})`, boolean: 'AND', bindings: subBindings ?? [] });
    }

    /** ANDs `column NOT IN (...)`; empty list → `NOT IN (NULL)`; also accepts a builder subquery. */
    public whereNotIn(b: OrmBuilderState, column: string | { sql: string }, values: readonly unknown[] | SqlSubquery): void {
        const colStr = colRef(b.tableName, column);
        if (Array.isArray(values)) {
            if (values.length === 0) return;
            const parts = values.map((v) => (isSqlValue(v) ? v.sql : '?'));
            const bindings = values.flatMap((v) => (isSqlValue(v) ? [...(v.bindings ?? [])] : [v]));
            this.push({
                sql: `${colStr} NOT IN (${parts.join(', ')})`,
                boolean: 'AND',
                bindings,
            });
            return;
        }
        const { sql: subSql, bindings: subBindings } = (values as SqlSubquery).toSQL();
        this.push({ sql: `${colStr} NOT IN (${subSql})`, boolean: 'AND', bindings: subBindings ?? [] });
    }

    /** ANDs a parenthesized OR group built from `{ column, operator?, value }` pairs. */
    public whereWithOr(b: OrmBuilderState, conditions: { column: string | { sql: string }; operator?: string; value: unknown }[]): void {
        if (conditions.length === 0) return;
        const parts: string[] = [];
        const bindings: any[] = [];
        for (const { column, operator, value } of conditions) {
            if (typeof column === 'object' && 'sql' in column && typeof column.sql === 'string' && column.sql.includes('?')) {
                parts.push(column.sql);
                bindings.push(value);
            } else {
                const colStr = colRef(b.tableName, column);
                parts.push(`${colStr} ${operator ?? '='} ?`);
                bindings.push(value);
            }
        }
        this.push({ sql: `(${parts.join(' OR ')})`, boolean: 'AND', bindings });
    }

    /** Runs the callback on a fresh builder of the same flavour, wraps its clauses in parens, and pushes the group. */
    public groupWhere<X extends OrmModel, T extends SimpleBuilder<X>>(b: T, cb: (q: T) => void, boolean: 'AND' | 'OR'): void {
        const sub = this.deps.spawnLike(b) as T;
        cb(sub);
        const clauses = sub.__internals().whereEngine.all();
        if (clauses.length === 0) return;
        const joined = clauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ');
        this.push({ sql: `(${joined})`, boolean, bindings: clauses.flatMap((w) => w.bindings) });
    }

    /** Filters to rows that HAVE a related record (optionally matching the callback). */
    public whereHas<X extends OrmModel, T extends SimpleBuilder<X>, B>(b: T, relationName: string, relation: OrmRelationContract, cb?: (q: B) => unknown): void {
        const relatedModel = relation.relatedModel();
        // Self-referencing relation (child table === parent table): alias the child table
        // as the relation name so the EXISTS subquery doesn't collide with the outer table.
        const parentState = b.__internals();
        const childAlias = relatedModel.table === parentState.tableName ? relationName : undefined;

        const sub = this.deps.spawnWhereHas(relatedModel);
        // The builder the callback is handed is named by the caller — `RelationBuilder<X, K>` / `RelationQuery`.
        cb?.(sub as B);
        const subState = sub.__internals();
        const clauses = subState.whereEngine.all();

        let exists = `EXISTS (SELECT 1 ${helpers.relationFromWhere(relation, parentState.tableName, b.model, childAlias, subState.enableSoftDeleteGuard)}`;
        const filters = this.deps.relationOnQuery(relation);
        const allClauses = [...filters, ...clauses];
        if (allClauses.length > 0) {
            const joined = allClauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ');
            exists += ` AND (${joined})`;
        }
        exists += ')';
        this.push({ sql: exists, boolean: 'AND', bindings: allClauses.flatMap((w) => w.bindings) });
    }
}
