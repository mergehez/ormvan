import type { Cols, ColsOf, HiddenOf, IsToManyRelation, Prettify, RelationBuilder, RelationKeyOf, RelationKeys, RelationModelOf, RelationRow, RowOf } from './orm_builder.ts';
import type { OrmBuilderState } from './orm_builder_state.ts';
import { ConvertNullable, CountSpec, modelHelpers as helpers, modelMeta, modelTable, WhereClause } from './orm_helpers.ts';
import type { MainQueryBuilder } from './orm_main_query_builder.ts';
import { OrmModel } from './orm_model_contract.ts';

import { PaginatedResult } from './orm_pagination.ts';
import type { OrmRelationContract } from './orm_relations.ts';
import { visibleColumns } from './orm_serialization.ts';
import { jsonArrayAggregate, jsonObject } from './orm_sql.ts';

/** A row type's own columns — its methods and `$`-state left out. */
type RowColumns<T> = ConvertNullable<Pick<T, Cols<T> & keyof T>>;

/** `RowColumns` for the keys `K` asks for. */
type OrmRowPick<T, K extends PropertyKey> = {
    [P in keyof RowColumns<T> as P extends K ? P : never]: RowColumns<T>[P];
};

/**
 * A preloaded related row, projected like the main query: the related model's columns minus its hidden ones. A
 * column the preload callback opted into with `withHidden(...)` is in `S`, so `OrmRowPick` keeps it.
 */
type PreloadRelatedRow<Row, K extends RelationKeys<Row>> = Omit<RowColumns<RelationRow<Row, K>>, HiddenOf<RelationModelOf<Row, K>>>;

// Whether the relation is a to-many (hasMany/hasManyThrough/manyToMany) -> array in the result
type IsToMany<Row, K extends RelationKeys<Row>> = IsToManyRelation<Row[K]>;
// `C` is a caller's column list: named through the relation's model (`ColsOf<RelationModelOf<…>>`) and read here as
// keys of the related ROW. Same names, so the row shape is unchanged — see `preload`'s parameter for the spelling.
type PreloadValueOf<Row, K extends RelationKeys<Row>, C extends PropertyKey, Maybe extends boolean> =
    IsToMany<Row, K> extends true
        ? Array<[C] extends [never] ? PreloadRelatedRow<Row, K> : OrmRowPick<RelationRow<Row, K>, C>>
        : ([C] extends [never] ? PreloadRelatedRow<Row, K> : OrmRowPick<RelationRow<Row, K>, C>) | (Maybe extends true ? null : never);
type PreloadValue<Row, K extends RelationKeys<Row>, C extends PropertyKey> = PreloadValueOf<Row, K, C, true>;
export type PreloadValueAssumed<Row, K extends RelationKeys<Row>, C extends PropertyKey> = PreloadValueOf<Row, K, C, false>;
export type PreloadValueMaybe<Row, K extends RelationKeys<Row>, C extends PropertyKey> = PreloadValue<Row, K, C>;

/**
 * The selected columns a sub-builder declared. A slot still holding its class-wide `string` means the callback
 * never called `select(...)`: the projection is the default one, i.e. `never` — not every column.
 */
type SelectedKeys<S> = [string] extends [S] ? never : Extract<S, string>;

/** The hidden columns a sub-builder opted into with `withHidden(...)`, from its own monotone slot. */
type HiddenKeys<Q> = Q extends { __hidden?: infer Hd } ? Extract<keyof (Hd extends object ? Hd : {}), string> : never;

// The shape of a callback-built sub-builder + nested preloads/counts/extras.
type PreloadRowShape<
    Row,
    K extends RelationKeys<Row>,
    S,
    P extends Record<string, unknown>,
    C extends Record<string, number>,
    E extends Record<string, unknown>,
    H extends PropertyKey = never,
> = Prettify<
    ConvertNullable<
        ([S] extends [never] ? PreloadRelatedRow<Row, K> : OrmRowPick<RelationRow<Row, K>, S & PropertyKey>) &
            OrmRowPick<RelationRow<Row, K>, H> & {
                [K2 in keyof P]: P[K2];
            } & { [K2 in keyof C]: number } & { [K2 in keyof E]: E[K2] }
    >
>;

/** Builder-shaped value for result inference (matches a builder's __state/__hidden). */
type PreloadBuilderLike<
    M extends OrmModel,
    S extends string = string,
    P extends Record<string, unknown> = {},
    C extends Record<string, number> = {},
    E extends Record<string, unknown> = {},
    Hd extends object = {},
> = {
    model: M;
    __state?: { selected: S; preloads: P; counts: C; extras: E };
    __hidden?: Hd;
    readonly __paginated?: boolean;
};

/**
 * The sub-builder state a paginated preload carries, read as leniently as possible: a builder an app helper
 * produced by casting (`this as MutateOrm<…>`) does not satisfy the precise check, so whatever keys ARE
 * recoverable are kept.
 */
type PreloadStateOf<Q> = Q extends { __state?: { selected: infer S; preloads: infer P; counts: infer C; extras: infer E } }
    ? {
          S: SelectedKeys<S>;
          // Mapped so a count key declared optional, or an interface-typed preload record, stays accepted.
          P: P extends object ? { [K in keyof P]: P[K] } : {};
          C: C extends object ? { [K in keyof C]: number } : {};
          E: E extends object ? { [K in keyof E]: E[K] } : {};
          H: HiddenKeys<Q>;
      }
    : { S: never; P: {}; C: {}; E: {}; H: never };

/**
 * The row shape a preload produces, from whatever state could be read off the sub-builder — a nested preload or
 * count the callback added is part of the row.
 */
type PreloadShapeOf<Q, Row, K extends RelationKeys<Row>> = PreloadRowShape<
    Row,
    K,
    PreloadStateOf<Q>['S'],
    PreloadStateOf<Q>['P'],
    PreloadStateOf<Q>['C'],
    PreloadStateOf<Q>['E'],
    PreloadStateOf<Q>['H']
>;

type PreloadRowOf<Row, K extends RelationKeys<Row>, Q, Maybe extends boolean> = Q extends {
    readonly __paginated: true;
}
    ? Q extends PreloadBuilderLike<OrmModel, infer S, infer P, infer C, infer E, infer Hd>
        ? PaginatedResult<PreloadRowShape<Row, K, SelectedKeys<S>, P, C, E, Extract<keyof Hd, string>>>
        : // Paginated, with a sub-builder type that could not be matched exactly: it is still a paginated
          // relation, so it gets `items` plus whatever state was recoverable.
          PaginatedResult<PreloadRowShape<Row, K, PreloadStateOf<Q>['S'], PreloadStateOf<Q>['P'], PreloadStateOf<Q>['C'], PreloadStateOf<Q>['E'], PreloadStateOf<Q>['H']>>
    : Q extends PreloadBuilderLike<OrmModel, infer S, infer P, infer C, infer E, infer Hd>
      ? IsToMany<Row, K> extends true
          ? Array<PreloadRowShape<Row, K, SelectedKeys<S>, P, C, E, Extract<keyof Hd, string>>>
          : PreloadRowShape<Row, K, SelectedKeys<S>, P, C, E, Extract<keyof Hd, string>> | (Maybe extends true ? null : never)
      : IsToMany<Row, K> extends true
        ? Array<PreloadShapeOf<Q, Row, K>>
        : PreloadShapeOf<Q, Row, K> | (Maybe extends true ? null : never);

export type PreloadRow<F, K extends RelationKeys<F>, Q> = PreloadRowOf<F, K, Q, false>;
export type PreloadRowMaybe<F, K extends RelationKeys<F>, Q> = PreloadRowOf<F, K, Q, true>;

/** The ORM-specific behaviors the engine needs but cannot provide itself. */
interface OrmPreloadDeps {
    /** A statement builder for a related model — a deferred preload runs its own paginated query on it. */
    spawnStatement(model: OrmModel): MainQueryBuilder<OrmModel>;
    relationOnQuery: (relation: OrmRelationContract) => WhereClause[];
    compileCountSql(parentModel: OrmModel, parentTable: string, count: CountSpec, bindings: any[], asAlias?: boolean, childAlias?: string): string;
}

/**
 * The preload engine: pure algorithms (compile / late-run), plus the preloads a builder has declared. It is not
 * generic: the builders it is handed are `OrmBuilderState`s of DIFFERENT models (one per relation), so its own type
 * cannot name one — each declaration method names the related model instead.
 */
export class OrmPreload {
    private preloads: Map<string, OrmBuilderState> = new Map();
    private latePreloads: Map<string, OrmBuilderState> = new Map();
    /** The object a preload wants where the relation row is missing, by relation — see `compilePreloadSql`. */
    private fallbacks: Map<string, unknown> = new Map();
    private pendingPagination: { perPage: number; getPage?: () => number } | null = null;

    public constructor(public deps: OrmPreloadDeps) {}

    // --- Narrow public read surface (keeps the maps/pending private) ---

    /** Whether a preload-callback builder marked itself paginated (`.paginating()`). */
    public hasPendingPagination(): boolean {
        return this.pendingPagination !== null;
    }

    /** The pending pagination spec set on this engine by `.paginating()` (or null). */
    public pendingPaginated(): { perPage: number; getPage?: () => number } | null {
        return this.pendingPagination;
    }

    /** Whether this engine deferred any preloads to late-execution. */
    public hasLatePreloads(): boolean {
        return this.latePreloads.size > 0;
    }

    /** Declare a preload (simple mapping into `this.preloads`). Flattens opts into the sub-builder's `.select`. */
    public preload<P extends OrmModel, K extends RelationKeyOf<P>, C extends ColsOf<RelationModelOf<RowOf<P>, K>> = never>(
        sub: RelationBuilder<P, K>,
        relation: K,
        opts?: C | C[],
        fallback?: unknown
    ): void {
        if (opts) sub.select(...(Array.isArray(opts) ? opts : [opts]));
        this.declare(relation, sub.__internals(), fallback);
    }

    public preloadMaybe<P extends OrmModel, K extends RelationKeyOf<P>, C extends ColsOf<RelationModelOf<RowOf<P>, K>> = never>(
        sub: RelationBuilder<P, K>,
        relation: K,
        opts?: C | C[],
        fallback?: unknown
    ): void {
        if (opts) sub.select(...(Array.isArray(opts) ? opts : [opts]));
        this.declare(relation, sub.__internals(), fallback);
    }

    /**
     * Declare a callback-built preload.
     *
     * `Recv` is the receiver the callback is handed, as a type parameter defaulting to `RelationBuilder<P, K>` rather
     * than that type spelled out: a host scope whose return type is being inferred cannot resolve a receiver type
     * named directly in a signature (see `preloadCb` in `orm_subquery_builder.ts`), and deferring it keeps the same
     * members available to the callback.
     */
    public preloadCb<P extends OrmModel, K extends RelationKeyOf<P>, Q, Recv extends RelationBuilder<P, K> = RelationBuilder<P, K>>(
        sub: RelationBuilder<P, K>,
        relation: K,
        cb: (q: Recv) => Q | void,
        fallback?: unknown
    ): void {
        cb(sub as Recv);
        // A chaining callback answers the builder it was handed, and `Q` only ever describes the row shape, so the
        // sub-builder's own wiring is what the preload carries — nothing to reconcile with the return value.
        this.declare(relation, sub.__internals(), fallback);
    }

    public preloadCbMaybe<P extends OrmModel, K extends RelationKeyOf<P>, Q, Recv extends RelationBuilder<P, K> = RelationBuilder<P, K>>(
        sub: RelationBuilder<P, K>,
        relation: K,
        cb: (q: Recv) => Q | void,
        fallback?: unknown
    ): void {
        cb(sub as Recv);
        this.declare(relation, sub.__internals(), fallback);
    }

    /** Registers a preload: its fallback (see `compilePreloadSql`), and where it runs. */
    private declare(relation: string, state: OrmBuilderState, fallback?: unknown): void {
        if (fallback !== undefined) this.fallbacks.set(relation, fallback);
        // A paginated preload is deferred to run after the main query; anything else joins its SELECT.
        if (state.preloadEngine.hasPendingPagination()) this.latePreloads.set(relation, state);
        else this.preloads.set(relation, state);
    }
    /**
     * Marks the pending preload paginated, for the main query to defer. The row-shape side of that (`items`) is the
     * chain's business, next to the method that declares it.
     */
    public paginating(perPage: number, getPage?: () => number): void {
        this.pendingPagination = { perPage, getPage };
    }

    /** Compile a (possibly nested) preload subquery. */
    public compilePreloadSql(parentModel: OrmModel, parentTable: string, rel: string, sub: OrmBuilderState, bindings: any[]): string {
        const relation = helpers.getRelationFor(parentModel, rel);
        const related = relation.relatedModel();
        const child = modelTable(related);
        const childAlias = child === parentTable ? rel : child;
        // Preloads are projected like the main query: the related model's visible columns plus whatever the
        // callback opted into via `withHidden(...)`. An explicit selection still wins.
        const selected = sub.selectEngine.all();
        const visible = selected.length ? [] : visibleColumns(related);
        const columns = selected.length
            ? selected.map((c) => (c.sql.startsWith(`${child}.`) ? c.sql.slice(child.length + 1) : c.sql))
            : visible.length
              ? [...visible, ...sub.selectedHiddenColumns]
              : undefined;
        const countKeys = sub.countEngine.compileJsonKeys(related, childAlias, bindings, childAlias === rel ? rel : undefined);
        // A joined model's columns ride in the same nested row — minus any name the row already has, the rule the main
        // projection uses, so a joined `id` cannot shadow the child's.
        const childKeys = new Set(columns ?? []);
        const joinedKeys = sub.joinedModels.flatMap((joined) =>
            helpers.jsonObjectArgs(
                joined,
                modelMeta(joined).table,
                visibleColumns(joined).filter((column) => !childKeys.has(column))
            )
        );
        // for (const [relationName, spec] of this.engine.preloadsEntries()) {
        //     selectClause.push(`${this.engine.compilePreloadSql(this.model, this.tableName, relationName, spec, preloadBindings)} AS ${relationName}`);
        // }
        const preloadKeys = sub.preloadEngine.getCompiledPreloadSqls(related, childAlias, bindings).map((c) => `'${c.relationName}', ${c.sql}`);
        const rowJson = jsonObject([...helpers.jsonObjectArgs(related, childAlias, columns), ...joinedKeys, ...countKeys, ...preloadKeys]);
        const aggregate = relation.type === 'hasMany' || relation.type === 'hasManyThrough' || relation.type === 'manyToMany' ? jsonArrayAggregate(rowJson) : rowJson;
        let sql = `(SELECT ${aggregate} ${helpers.relationFromWhere(
            relation,
            parentTable,
            parentModel,
            childAlias === rel ? rel : undefined,
            sub.enableSoftDeleteGuard,
            sub.joinClauses.map((j) => j.sql)
        )}`;
        bindings.push(...sub.joinClauses.flatMap((j) => j.bindings));
        const clauses = [...this.deps.relationOnQuery(relation), ...sub.whereEngine.all()];
        if (clauses.length) {
            sql += ` AND ${clauses.map((w, i) => (i === 0 ? w.sql : `${w.boolean} ${w.sql}`)).join(' ')}`;
            bindings.push(...clauses.flatMap((w) => w.bindings));
        }
        const tail = helpers.renderTailClauses(sub.groupByClauses, sub.havings, sub.orderByClauses, sub.limitValue, sub.offsetValue);
        sql += tail.sql;
        bindings.push(...tail.bindings);
        const subquery = `${sql})`;

        const fallback = this.fallbacks.get(rel);
        if (fallback === undefined) return subquery;

        // `IFNULL` rather than a pass over the rows: a nested preload is inside this JSON, so the substitute has
        // to be in the SQL. The bound literal keeps the fallback out of the statement text.
        bindings.push(JSON.stringify(fallback));
        return `IFNULL(${subquery}, CAST(? AS JSON))`;
    }

    public getCompiledPreloadSqls(model: OrmModel, tableName: string, bindings: any[]) {
        return [...this.preloads.entries()].map(([relationName, spec]) => {
            return {
                relationName,
                sql: this.compilePreloadSql(model, tableName, relationName, spec, bindings),
            };
        });
    }

    /** Compile deferred preloads for diagnostic SQL output. */
    public getCompiledLatePreloadSqls(model: OrmModel, tableName: string, bindings: any[]) {
        return [...this.latePreloads.entries()].map(([relationName, spec]) => {
            return {
                relationName,
                sql: this.compilePreloadSql(model, tableName, relationName, spec, bindings),
            };
        });
    }

    /** Copy the nested preload bookkeeping from another engine (a deferred preload that got a fresh builder). */
    private adoptFrom(source: OrmPreload): void {
        this.preloads = new Map(source.preloads);
        this.latePreloads = new Map(source.latePreloads);
        this.fallbacks = new Map(source.fallbacks);
        this.pendingPagination = source.pendingPagination;
    }

    /** Copies the wiring a deferred preload was declared with onto the fresh builder it now runs on. */
    private adoptStateFrom(d: OrmBuilderState, src: OrmBuilderState): void {
        d.whereEngine.replaceAll(src.whereEngine.all());
        d.limitValue = src.limitValue;
        d.offsetValue = src.offsetValue;
        d.havings = [...src.havings];
        d.orderByClauses = [...src.orderByClauses];
        d.groupByClauses = [...src.groupByClauses];
        d.countEngine.replaceAll(src.countEngine.all());
        d.selectEngine.replaceAll(src.selectEngine.all());
        d.joinClauses = [...src.joinClauses];
        d.joinedModels = [...src.joinedModels];
        d.enableSoftDeleteGuard = src.enableSoftDeleteGuard;
        d.preloadEngine.adoptFrom(src.preloadEngine);
    }

    /** Re-run deferred (`.paginating()`) preloads for fetched parent `rows`. */
    public async runLatePreloads(model: OrmModel, rows: Array<Record<string, unknown>>): Promise<void> {
        for (const [rel, stored] of this.latePreloads) {
            const relation = helpers.getRelationFor(model, rel);
            const related = relation.relatedModel();
            const { localKey, foreignKey } = helpers.getRelationKeys(relation, model);
            const parentRef = relation.type === 'belongsTo' ? foreignKey : localKey;
            const childRef = relation.type === 'belongsTo' ? localKey : foreignKey;
            const ids = rows.map((r) => r[parentRef]).filter((v) => v !== null && v !== undefined);
            if (!ids.length) {
                for (const r of rows) r[rel] = null;
                continue;
            }
            const sub = this.deps.spawnStatement(related);
            const state = sub.__internals();
            this.adoptStateFrom(state, stored);
            const ph = ids.map(() => '?').join(', ');
            state.whereEngine.addRaw(`${state.tableName}.${childRef} IN (${ph})`, ids);
            const pending = stored.preloadEngine.pendingPaginated();
            if (!pending) continue;
            const page = Math.max(1, pending.getPage?.() ?? 1);
            const paginated = await sub.paginate(page, pending.perPage);
            for (const r of rows) r[rel] = paginated;
        }
    }
}
