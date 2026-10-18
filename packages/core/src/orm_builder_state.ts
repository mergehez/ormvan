/**
 * The wiring a builder drives, in a class of its own because none of it depends on the model: the table, the engines
 * the chain hands its clauses to, and the clauses they record into.
 *
 * The engines are classes of their own and cannot read a `protected` field, so this is the handle they take — and the
 * one a builder hands out through `__internals()`. A chain itself offers queries, never this.
 */
import type { OrmQueryable } from './executor.ts';
import type { BuilderCtor } from './orm_builder.ts';
import type { OrmCount } from './orm_count.ts';
import type { JoinClause } from './orm_helpers.ts';
import type { OrmModel } from './orm_model_contract.ts';
import type { OrmPreload } from './orm_preload.ts';
import type { OrmSelect } from './orm_select.ts';
import type { OrmWhere } from './orm_where.ts';

export class OrmBuilderState {
    /** The transaction (or connection) this query runs through — sub-builders inherit it. See `withClient()`. */
    public client?: OrmQueryable;
    /**
     * Whether this builder applies its model's soft-delete scope. Set by the model's `withTrashed()` scope, on the
     * builder it was called on: a sub-builder keeps its own (the callback that spawns it decides), so nothing is
     * lifted silently. See `orm_soft_delete.ts`.
     */
    public enableSoftDeleteGuard = true;
    /** Columns explicitly selected via `withHidden(...)` — appended to the default projection. */
    public selectedHiddenColumns: string[] = [];
    public limitValue?: number;
    public offsetValue?: number;
    public havings: { sql: string; bindings: any[] }[] = [];
    public orderByClauses: { sql: string; bindings: any[] }[] = [];
    public groupByClauses: string[] = [];
    public joinClauses: JoinClause[] = [];
    /** Models joined in by `join(Model, …)`: their columns join the projection, and their row type joins the row. */
    public joinedModels: OrmModel[] = [];

    // Filled by the builder that owns this state, right after construction: each engine is constructed from deps
    // that read this object back.
    public preloadEngine!: OrmPreload;
    public countEngine!: OrmCount;
    public whereEngine!: OrmWhere;
    public selectEngine!: OrmSelect;

    public constructor(
        /** The class a sub-builder is spawned as — see `BuilderCtor`. */
        public builderClass: BuilderCtor,
        public tableName: string
    ) {}

    /** Copies what a sub-builder inherits from the builder that spawned it. */
    public inherit(from: OrmBuilderState): void {
        this.builderClass = from.builderClass;
        if (from.client) this.client = from.client;
    }
}
