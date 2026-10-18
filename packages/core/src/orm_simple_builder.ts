/**
 * What every flavour shares: the builder's state and its engines, the where family (`where` … `whereHas`), the
 * soft-delete toggle and the model's scopes. Nothing here belongs to a single flavour — the preload surface is
 * `SubqueryBuilder`, the count surface `CountQuery`, and the members only a standalone query can use (`toSQL`,
 * `withClient`, the joins) or that execute SQL live in `MainQueryBuilder`.
 */
import {
    appOnlyStack,
    ORM_SCOPE,
    type BuilderCtor,
    type ColsOf,
    type ModelBuilder,
    type ModelColumn,
    type Obj,
    type QualifiedColumn,
    type RelationKeyOf,
    type RelationQuery,
} from './orm_builder.ts';
import { OrmBuilderState } from './orm_builder_state.ts';
import { ormConfig } from './orm_config.ts';
import { OrmCount } from './orm_count.ts';
import { modelHelpers as helpers, modelMeta, modelTable, type OrmModelMeta, type SqlSubquery } from './orm_helpers.ts';
import type { OrmModel } from './orm_model_contract.ts';
import { OrmPreload } from './orm_preload.ts';
import type { OrmRelationContract } from './orm_relations.ts';
import { OrmSelect } from './orm_select.ts';
import { OrmWhere } from './orm_where.ts';

/** A model's scopes, keyed by the name the chain exposes. Cached per model. */
const scopeCache = new WeakMap<object, Record<string, (b: object, ...args: unknown[]) => unknown>>();

/**
 * A column a clause accepts when it names one: a model column — hidden ones included, since naming a column in a clause
 * is not a projection — an already-qualified `table.column` (a joined table, or the child table inside a subquery), or
 * a raw expression. The tail clauses take this plus what MySQL only knows after SELECT (`TailColumn`); a WHERE cannot
 * name one of those, which is the one difference between the two.
 */
export type WhereColumn<X extends OrmModel> = ModelColumn<X> | QualifiedColumn | { sql: string };

function scopesOf(model: OrmModel): Record<string, (b: object, ...args: unknown[]) => unknown> {
    const cached = scopeCache.get(model);
    if (cached) return cached;

    const scopes: Record<string, (b: object, ...args: unknown[]) => unknown> = {};
    for (let proto: object | null = model; proto && proto !== Function.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const key of Object.getOwnPropertyNames(proto)) {
            if (Object.hasOwn(scopes, key)) continue;
            const fn = (proto as Obj)[key];
            if (typeof fn === 'function' && (fn as { [ORM_SCOPE]?: boolean })[ORM_SCOPE] === true) {
                scopes[key] = fn as (b: object, ...args: unknown[]) => unknown;
            }
        }
    }

    scopeCache.set(model, scopes);
    return scopes;
}

/** The chain every flavour shares. */
export abstract class SimpleBuilder<X extends OrmModel> {
    /**
     * What the chain has built up so far. The slots are declared as WIDE as they go, and a chain method narrows or
     * widens them by intersection (`Rebuild`) — so a rebuild keeps the class the caller holds, adding a count alias
     * or a preload is never blocked by an exact slot, and no state has to be threaded through a class parameter.
     */
    declare public readonly __state?: {
        selected: string;
        preloads: {};
        counts: {};
        extras: {};
    };

    /**
     * The hidden columns this chain has opted into (`withHidden`). Its own slot because it only grows: the
     * selection narrows, the opt-in accumulates, and both are applied by intersection.
     */
    declare public readonly __hidden?: {};

    /**
     * The receiver, claiming the row-state phantom a chain call just recorded (`select`, `withCount`, `preload*`,
     * `withHidden`) — or several of them, as an app's own helper does. The slots above are declared as wide as they
     * go and a chain narrows them by intersection, so claiming one is an assertion: stated once here, and inferred
     * from the caller's declared return type, which is therefore the single place its type is written.
     *
     * Public — the `__` prefix is the convention for that — because an app helper that calls several chain methods
     * and returns once needs exactly this seam, and the engine's own methods use no other.
     */
    public __claim<Phantom extends this>(): Phantom {
        return this as Phantom;
    }

    public initiatedFrom?: string;

    public model: X;
    /** Everything the engine reads off the model: table, primary key, columns, hidden set, relations. */
    protected meta: OrmModelMeta;
    protected primaryKey: ColsOf<X>;

    /**
     * The wiring the engines drive: the table, the engines this chain hands its clauses to, and the clauses
     * themselves (`OrmBuilderState`). It is an object of its own because the engines are classes of their own and
     * cannot read a `protected` field — a chain offers queries, and `__internals()` is the hatch onto this.
     */
    protected readonly state: OrmBuilderState;

    constructor(model: X) {
        this.model = model;
        this.meta = modelMeta(model);
        this.primaryKey = model.primaryKey as ColsOf<X>;
        this.initiatedFrom = ormConfig().logExecutionPaths ? appOnlyStack() : ''; //appOnlyStack();
        // The class a sub-builder is spawned as is the class the caller built — not every builder's own class, since a
        // spawned builder may be a flavour class (`PreloadQueryBuilder`), which cannot run what a sub-builder runs.
        this.state = new OrmBuilderState(this.constructor as BuilderCtor, modelTable(model));

        const state = this.state;
        state.selectEngine = new OrmSelect({
            tableName: () => state.tableName,
        });
        state.whereEngine = new OrmWhere({
            makeBuilder: <M extends OrmModel>(m: M) => this.makeBuilder(m),
            spawnWhereHas: <M extends OrmModel>(m: M) => this.spawnWhereHasSub(m),
            spawnLike: <M extends OrmModel>(b: SimpleBuilder<M>) => this.spawnLikeSub(b),
            relationOnQuery: (rel) => this.relationOnQuery(rel),
        });
        state.countEngine = new OrmCount({
            relationOnQuery: (rel) => this.relationOnQuery(rel),
        });
        state.preloadEngine = new OrmPreload({
            spawnStatement: (model) => this.makeBuilder(model),
            relationOnQuery: (rel) => this.relationOnQuery(rel),
            compileCountSql: (pm, pt, c, b, asAlias, childAlias) => state.countEngine.compileCountSql(pm, pt, c, b, asAlias, childAlias),
        });
        // The model's scopes become chainable methods, with this builder as the scope's first argument.
        const scopes = scopesOf(model);
        for (const name of Object.keys(scopes)) {
            const scope = scopes[name];
            (this as Obj)[name] = (...args: unknown[]) => scope.call(model, this, ...args);
        }
    }

    /**
     * Copies what a sub-builder inherits — the class it is spawned as, the soft-delete scope and the transaction —
     * onto a builder an engine spawned. The rule itself lives on the state (`OrmBuilderState.inherit`), so every
     * spawn site applies exactly the same one.
     */
    protected adoptStateInto<M extends OrmModel>(dest: SimpleBuilder<M>): void {
        dest.__internals().inherit(this.state);
    }

    /**
     * The wiring the engines drive, for code outside this class hierarchy. A host never needs it: the chain exposes
     * queries, and this exposes what they are built from.
     */
    public __internals(): OrmBuilderState {
        return this.state;
    }

    /**
     * Builds a sub-builder for `model` — a fresh instance of the class this chain was started with, so every internal
     * caller sees the whole chain.
     */
    protected makeBuilder<M extends OrmModel>(model: M) {
        const sub = new this.state.builderClass(model);
        // The soft-delete state, the transaction and the spawn class flow into every sub-builder.
        this.adoptStateInto(sub);
        return sub as ModelBuilder<M>;
    }

    /**
     * The builder a `whereHas` callback is handed — its own class, so what the callback receives is exactly what its
     * `RelationQuery` type offers: the WHERE family (the only thing an `EXISTS (SELECT 1 …)` subquery contributes).
     */
    protected spawnWhereHasSub<M extends OrmModel>(model: M): WhereHasQueryBuilder<M> {
        const sub = new WhereHasQueryBuilder(model);
        this.adoptStateInto(sub);
        return sub;
    }

    /** A fresh builder of the same flavour as `like`: a grouped WHERE's sub-builder is the class its type names. */
    protected spawnLikeSub<M extends OrmModel>(like: SimpleBuilder<M>): SimpleBuilder<M> {
        const sub = new (like.constructor as new (model: M) => SimpleBuilder<M>)(like.model);
        this.adoptStateInto(sub);
        return sub;
    }

    /**
     * Extracts a relation's `onQuery` clauses as declared WHERE fragments. Returns [] when there is no onQuery,
     * or when the callback uses something the sub-builder cannot translate.
     */
    protected relationOnQuery(relation: OrmRelationContract) {
        const onQuery = relation.options?.onQuery;
        if (!onQuery) return [];

        try {
            const sub = this.makeBuilder(relation.relatedModel());
            onQuery(sub);
            return sub.__internals().whereEngine.all();
        } catch {
            return [];
        }
    }

    // --- CHAINABLE API ---
    public where(column: WhereColumn<X>, operator: any, value?: any): this {
        this.state.whereEngine.where(this.state, column, operator, value);
        return this;
    }
    /** ANDs `column != value` — negated equality. */
    public whereNot(column: WhereColumn<X>, value: any): this {
        this.state.whereEngine.whereNot(this.state, column, value);
        return this;
    }

    /**
     * ANDs the callback's clauses into the query as a parenthesized group:
     * `... AND (a = ? AND b = ? OR c = ?)` — respects each clause's own connector,
     * so nested `whereGrouped`/`orWhere(cb)` groups compose recursively.
     */
    public whereGrouped(cb: (q: this) => void, boolean: 'AND' | 'OR' = 'AND'): this {
        this.state.whereEngine.groupWhere(this, cb as (q: typeof this) => void, boolean);
        return this;
    }

    public orWhere(column: WhereColumn<X>, operator: any, value?: any): this;
    /** Groups the callback's clauses in parens and ORs them: `... OR (a = ? AND b = ?)` (wrapped-clause semantics). */
    public orWhere(cb: (q: this) => void): this;
    public orWhere(column: WhereColumn<X> | ((q: this) => void), operator?: any, value?: any): this {
        if (typeof column === 'function') this.state.whereEngine.groupWhere(this, column, 'OR');
        else this.state.whereEngine.where(this.state, column, operator ?? '=', value, 'OR');
        return this;
    }

    /** ANDs a parenthesized OR group: `... AND (col1 = ? OR col2 like ?)`. */
    public whereWithOr(conditions: { column: WhereColumn<X>; operator?: string; value: unknown }[]): this {
        this.state.whereEngine.whereWithOr(this.state, conditions);
        return this;
    }

    public whereNull(column: WhereColumn<X>): this {
        this.state.whereEngine.whereNull(this.state, column);
        return this;
    }
    public whereNotNull(column: WhereColumn<X>): this {
        this.state.whereEngine.whereNotNull(this.state, column);
        return this;
    }

    /** ANDs a raw WHERE fragment: `whereRaw('LOWER(title) = ?', ['x'])`. */
    public whereRaw(sql: string, bindings?: any[]): this {
        this.state.whereEngine.whereRaw(sql, bindings);
        return this;
    }

    /** ANDs `column IN (?, ?, ...)`; an empty list compiles to `IN (NULL)`; also accepts a builder subquery. */
    public whereIn(column: WhereColumn<X>, values: readonly unknown[] | SqlSubquery): this {
        this.state.whereEngine.whereIn(this.state, column, values);
        return this;
    }

    /** ANDs `column NOT IN (?, ?, ...)`; an empty list compiles to `NOT IN (NULL)`; also accepts a builder subquery. */
    public whereNotIn(column: WhereColumn<X>, values: readonly unknown[] | SqlSubquery): this {
        this.state.whereEngine.whereNotIn(this.state, column, values);
        return this;
    }

    public whereTwoColumnsMatch(columns: [WhereColumn<X>, WhereColumn<X>], vals: [any, any]) {
        // The whole OR must be parenthesized, or an OR branch escapes a preceding AND (AND binds tighter).
        return this.whereGrouped((g) => {
            g.where(columns[0], vals[0]).where(columns[1], vals[1]);
            g.orWhere((q) => q.where(columns[0], vals[1]).where(columns[1], vals[0]));
        });
    }
    public whereOneOfCols(columns: WhereColumn<X>[], operator: any, value?: any) {
        return this.whereGrouped((b) => {
            b = b.where(columns[0], operator, value);
            for (let i = 1; i < columns.length; i++) {
                b = b.orWhere(columns[i], operator, value);
            }
            return b;
        });
    }

    /** Filters to rows that HAVE a related record, optionally matching the callback. The child's soft-delete scope is applied. */
    public whereHas<K extends RelationKeyOf<X>>(relationName: K, cb?: (q: RelationQuery<X, K>) => unknown): this {
        this.state.whereEngine.whereHas<X, this, RelationQuery<X, K>>(this, relationName, helpers.getRelationFor(this.model, relationName), cb);
        return this;
    }

    /**
     * Applies `matchCallback(this)` when `condition` is truthy, else `noMatchCallback?.(this)`.
     *
     * Each callback brings its own result type (`Q | N`). With no `else` the result is the match callback's, so
     * `if(cond, (q) => q.select('id'))` reads as "selected".
     */
    public if<T extends this, Q>(this: T, condition: unknown, matchCallback: (q: T) => Q, noMatchCallback?: undefined): Q;
    public if<T extends this, Q, N>(this: T, condition: unknown, matchCallback: (q: T) => Q, noMatchCallback: (q: T) => N): Q | N;
    public if<T extends this, Q, N>(this: T, condition: unknown, matchCallback: (q: T) => Q, noMatchCallback?: (q: T) => N): Q | N {
        if (condition) return matchCallback(this);
        return (noMatchCallback ? noMatchCallback(this) : this) as Q | N;
    }

    /** Joins the WHERE clauses with their AND/OR connectors, soft-delete scope included. */
    protected compileWhere(): string | null {
        return this.state.whereEngine.compileWhere(this.state.tableName, this.model, this.state.enableSoftDeleteGuard);
    }
}

/**
 * The builder a `whereHas` callback is handed: the WHERE family, and nothing else — the subquery it feeds is
 * `EXISTS (SELECT 1 …)`, so a projection, a join or a tail would be members nothing reads.
 *
 * Declared beside `SimpleBuilder` rather than as a `RelationSubquery` because `orm_relation_subquery.ts` extends this
 * module, so importing it back would close a cycle. The two declare the same members, which is what keeps this class
 * and the `RelationQuery` type its callback is typed with from drifting apart.
 */
export class WhereHasQueryBuilder<X extends OrmModel> extends SimpleBuilder<X> {}
