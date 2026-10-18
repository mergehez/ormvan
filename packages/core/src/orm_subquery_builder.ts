import type { RelationModelOf } from './orm_builder.ts';
import {
    type ColsOf,
    type HiddenOf,
    type IsToManyRelation,
    type OrmRow,
    type PossibleCountsKey,
    type PossiblePreloadKey,
    type RelationBuilder,
    type RelationKeyOf,
    type RowOf,
} from './orm_builder.ts';
import { countAliasOf, type CountSubquery } from './orm_count.ts';
import { CountQueryBuilder } from './orm_count_query_builder.ts';
import { modelHelpers as helpers, modelMeta } from './orm_helpers.ts';
import type { OrmModel } from './orm_model_contract.ts';
import { type PreloadRow, type PreloadRowMaybe, type PreloadValueAssumed, type PreloadValueMaybe } from './orm_preload.ts';
import type { AliasCount, RelationCount, StateOf, WithAddedCounts, WithAddedExtras, WithAddedPreloads, WithHidden, WithSelect } from './orm_rebuild.ts';
import { RelationSubquery } from './orm_relation_subquery.ts';
import type { SelectItem } from './orm_select.ts';
import { visibleColumns } from './orm_serialization.ts';
import type { SoftDeleteToggles } from './orm_soft_delete.ts';
import type { WhereColumn } from './orm_simple_builder.ts';

/** What a join's `ON` accepts — `'='` by default on `joinSub` (`join` takes it explicitly). */
export type JoinOperator = '=' | '!=' | '<' | '<=' | '>' | '>=';

/**
 * A preload fallback is for a to-one relation: the object a caller wants where the row is missing. A to-many
 * cannot take one — `[]` is its own "none", and a fallback would have to replace the array.
 */
type PreloadFallback<X extends OrmModel, K extends RelationKeyOf<X>, F> = IsToManyRelation<RowOf<X>[K]> extends true ? never : F;

/**
 * A column the tail clauses (`orderBy`, `groupBy`, `having`, `latest`, `oldest`) accept: everything `WhereColumn`
 * takes — a model column (hidden ones included), a qualified `table.column`, a raw expression — plus the names MySQL
 * only knows after SELECT: a `withCount` alias, or a `select`/`colAs` alias. A WHERE that named one of those could
 * not be resolved, which is why the two clause families are two types.
 */
type TailColumn<X extends OrmModel, B> = WhereColumn<X> | Extract<keyof StateOf<B>['C'], string> | Extract<keyof StateOf<B>['E'], string>;
// type WhereColumn<X extends OrmModel> = ModelColumn<X> | QualifiedColumn | { sql: string };

/** The column an `orderBy` clause orders by, or `null` for a raw one (`orderByRaw`, which is left alone). */
function orderedColumn(sql: string): string | null {
    const match = /^(.*)\s(asc|desc)$/i.exec(sql.trim());

    return match ? match[1] : null;
}

/** The count aliases a `withCount` call adds: the alias the caller named, or `<relation>_count` when there is none. */
type CountsOf<K extends string, A extends string> = [A] extends [never] ? RelationCount<K> : AliasCount<A>;

/**
 * The surface a preload and a main query share: `select`, `withHidden`, the joins, the tail clauses, nested
 * `preload`/`withCount` — everything `orm_preload.ts` reads when it compiles a preload, so a callback cannot write a
 * clause the compiler would drop. A preload callback is handed `PreloadQueryBuilder` (this plus `paginating`), a
 * count/`whereHas` callback `RelationSubquery` (the WHERE family only, which is all their compilers read), and the
 * members that own a statement (`toSQL`, `withClient`, `union`) live in `MainQueryBuilder`.
 */
export abstract class SubqueryBuilder<X extends OrmModel> extends RelationSubquery<X> {
    /** Opts hidden columns into the SELECT and the row type: `User.orm().withHidden('password').first()`. */
    public withHidden<H extends string & HiddenOf<X>>(...columns: H[]): WithHidden<this, H> {
        this.state.selectedHiddenColumns = [...this.state.selectedHiddenColumns, ...columns];
        return this.__claim();
    }

    public limit(amount: number) {
        this.state.limitValue = amount;
        return this;
    }

    public offset(amount: number) {
        this.state.offsetValue = amount;
        return this;
    }

    private qualifiedOrderByKey(column: string): string {
        if (column.includes('.') || column.includes('(') || column.includes(' ') || column.includes('`')) {
            return column;
        }

        const isModelColumn = [...modelMeta(this.model).columnNames.values()].includes(column);
        return isModelColumn ? `${this.state.tableName}.${column}` : column;
    }

    /**
     * Orders by `column`. One clause per column: passing the same column again replaces what it said before, in
     * place, so the columns keep the order they were first named in.
     */
    public orderBy(column: TailColumn<X, this>, direction: 'asc' | 'desc' = 'asc') {
        const colStr = typeof column === 'string' ? this.qualifiedOrderByKey(column) : column.sql;
        const clauses = this.state.orderByClauses;
        const at = clauses.findIndex((clause) => orderedColumn(clause.sql) === colStr);
        const clause = { sql: `${colStr} ${direction}`, bindings: [] };

        if (at === -1) clauses.push(clause);
        else clauses[at] = clause;
        return this;
    }

    /**
     * The newest row first: orders by `column` (the primary key by default) descending.
     *
     * ```ts
     * const newest = await Message.orm().where('receiver_id', id).latest().first();
     * const newestBySent = await Message.orm().latest('sent_at').first();
     * ```
     *
     * It replaces an ordering this chain already had on that column, and leaves the other columns' clauses — and
     * their order — alone.
     */
    public latest(column: TailColumn<X, this> = this.primaryKey) {
        return this.orderBy(column, 'desc');
    }

    /**
     * The oldest row first: `latest()` the other way round.
     *
     * ```ts
     * const firstEver = await Message.orm().oldest().first();
     * ```
     */
    public oldest(column: TailColumn<X, this> = this.primaryKey) {
        return this.orderBy(column, 'asc');
    }

    public orderByRaw(sql: string, bindings?: any[]) {
        this.state.orderByClauses.push({ sql, bindings: bindings ?? [] });
        return this;
    }

    /** Adds a `GROUP BY` (accepts base columns, selected aliases, count aliases, or raw fragments): `groupBy('question_id')`. */
    public groupBy(column: TailColumn<X, this>, ...additional: TailColumn<X, this>[]) {
        const cols = [column, ...additional].map((c) => (typeof c === 'string' ? this.qualifiedOrderByKey(c) : c.sql));
        this.state.groupByClauses.push(...cols);
        return this;
    }

    /** ANDs a HAVING condition — usually filtering on a `withCount` alias: `having('comments_count', '>', 0)`. */
    public having(column: TailColumn<X, this>, operator: any, value?: any) {
        const colStr = typeof column === 'string' ? this.qualifiedOrderByKey(column) : column.sql;
        if (value === undefined) {
            this.state.havings.push({ sql: `${colStr} = ?`, bindings: [operator] });
        } else {
            this.state.havings.push({ sql: `${colStr} ${operator} ?`, bindings: [value] });
        }
        return this;
    }

    /** `select('id', 'title', { sql, bindings })`, `select('id as target_id')`, or `select(colAs('id', 'target_id'))`; no args / `'*'` = all columns. */
    public select<C extends Array<SelectItem<X>>>(...cols: C): WithSelect<this, C> {
        this.state.selectEngine.select(this.state.tableName, ...cols);
        return this.__claim();
    }

    /**
     * Joins a model's table, and the row gains that model's columns:
     *
     * ```ts
     * const rows = await Move.orm().join(Game, 'game_id', '=', 'id').get();
     * rows[0].title; // Game's column — typed, and selected
     * ```
     *
     * The table is the model's own, so it cannot be misspelled. The operands follow the sides: the left one is a
     * column of this model, the right one of the joined model, and each is qualified with the table of its side. The
     * joined model's visible columns are added to the projection — inside a preload, to the nested row — because the
     * row type says they are there, and a name both sides have stays with this model, so a joined `id` cannot shadow
     * this model's.
     *
     * `joinSql('games as g', …)` is the untyped form: an alias, or a table no model describes.
     */
    public join<M extends OrmModel>(model: M, left: ColsOf<X> | { sql: string }, operator: JoinOperator, right: ColsOf<M> | { sql: string }): WithAddedExtras<this, OrmRow<M>> {
        return this.addJoin('INNER', model, left, operator, right).__claim();
    }

    /** `LEFT JOIN` a model — every row of this model, matched or not. */
    public leftJoin<M extends OrmModel>(model: M, left: ColsOf<X> | { sql: string }, operator: JoinOperator, right: ColsOf<M> | { sql: string }): WithAddedExtras<this, OrmRow<M>> {
        return this.addJoin('LEFT', model, left, operator, right).__claim();
    }

    /** `RIGHT JOIN` a model — every row of the joined table. */
    public rightJoin<M extends OrmModel>(
        model: M,
        left: ColsOf<X> | { sql: string },
        operator: JoinOperator,
        right: ColsOf<M> | { sql: string }
    ): WithAddedExtras<this, OrmRow<M>> {
        return this.addJoin('RIGHT', model, left, operator, right).__claim();
    }

    /** `CROSS JOIN` a model — every combination, with no `ON`. */
    public crossJoin<M extends OrmModel>(model: M): WithAddedExtras<this, OrmRow<M>> {
        this.state.joinedModels.push(model);
        this.state.joinClauses.push({ sql: `CROSS JOIN ${modelMeta(model).table}`, bindings: [] });
        return this.__claim();
    }

    /**
     * `join(Model, …)` with a table name instead — for an alias (`'games as g'`) or a table no model describes. It has
     * no model to take columns from, so the row is unchanged.
     */
    public joinSql(table: string, left: ColsOf<X> | string | { sql: string }, operator: JoinOperator, right: string | { sql: string }): this {
        return this.addJoin('INNER', table, left, operator, right);
    }

    /** The `joinSql` form of a `LEFT JOIN`. */
    public leftJoinSql(table: string, left: ColsOf<X> | string | { sql: string }, operator: JoinOperator, right: string | { sql: string }): this {
        return this.addJoin('LEFT', table, left, operator, right);
    }

    /** The `joinSql` form of a `RIGHT JOIN`. */
    public rightJoinSql(table: string, left: ColsOf<X> | string | { sql: string }, operator: JoinOperator, right: string | { sql: string }): this {
        return this.addJoin('RIGHT', table, left, operator, right);
    }

    /** `CROSS JOIN` a table name — every combination, with no `ON` and no columns added. */
    public crossJoinSql(table: string): this {
        this.state.joinClauses.push({ sql: `CROSS JOIN ${table}`, bindings: [] });
        return this;
    }

    /**
     * The clause `join`/`joinSql` share: `<TYPE> JOIN <table> ON <left> <op> <right>`. A model target is resolved to
     * its table, remembered for the projection, and used to qualify the right operand.
     */
    private addJoin(
        type: 'INNER' | 'LEFT' | 'RIGHT',
        target: OrmModel | string,
        left: ColsOf<X> | string | { sql: string },
        operator: string,
        right: string | { sql: string }
    ): this {
        const joined = typeof target === 'string' ? undefined : target;
        const table = joined ? modelMeta(joined).table : (target as string);

        const leftColRef = typeof left !== 'string' ? left.sql : left.includes('.') ? left : `${this.state.tableName}.${left}`;
        const rightColRef = typeof right !== 'string' ? right.sql : joined && !right.includes('.') ? `${table}.${right}` : right;

        this.state.joinClauses.push({ sql: `${type} JOIN ${table} ON ${leftColRef} ${operator} ${rightColRef}`, bindings: [] });
        if (joined) this.state.joinedModels.push(joined);
        return this;
    }

    /**
     * The columns each joined model contributes to the projection, qualified by its table. A name this model also has
     * is left out: selecting it twice would let the joined table's value shadow this model's in the row.
     */
    protected joinedColumns(): string[] {
        if (this.state.joinedModels.length === 0) return [];

        const own = new Set(visibleColumns(this.model));
        return this.state.joinedModels.flatMap((joined) => {
            const table = modelMeta(joined).table;
            return visibleColumns(joined)
                .filter((column) => !own.has(column))
                .map((column) => `${table}.\`${column}\``);
        });
    }

    public preload<K extends PossiblePreloadKey<X, StateOf<this>['P']>, C extends ColsOf<RelationModelOf<RowOf<X>, K>> = never, F = never>(
        relationName: K,
        opts?: C | C[],
        fallback?: PreloadFallback<X, K, F>
    ): WithAddedPreloads<this, { [P in K]: PreloadValueAssumed<RowOf<X>, P, C> | F }> {
        this.state.preloadEngine.preload(this.preloadSubBuilder(relationName), relationName, opts, fallback);

        return this.__claim();
    }

    public preloadMaybe<K extends PossiblePreloadKey<X, StateOf<this>['P']>, C extends ColsOf<RelationModelOf<RowOf<X>, K>> = never, F = never>(
        relationName: K,
        opts?: C | C[],
        fallback?: PreloadFallback<X, K, F>
    ): WithAddedPreloads<this, { [P in K]: PreloadValueMaybe<RowOf<X>, P, C> | F }> {
        this.state.preloadEngine.preloadMaybe(this.preloadSubBuilder(relationName), relationName, opts, fallback);

        return this.__claim();
    }

    /**
     * `Recv` is the receiver the callback is handed. It is a type parameter defaulting to `RelationBuilder<X, K>`
     * rather than that type named directly: resolving the receiver while a host scope's return type is being inferred
     * is circular — TS reports TS7024 on the scope, so `scope((b) => b.preloadCb('x', (q) => q.withTrashed()))` could
     * not be inferred at all — and deferring it behind a parameter keeps the same members available to the callback.
     */
    public preloadCb<K extends PossiblePreloadKey<X, StateOf<this>['P']>, Q, F = never, Recv extends RelationBuilder<X, K> = RelationBuilder<X, K>>(
        relationName: K,
        cb: (q: Recv) => Q | void,
        fallback?: PreloadFallback<X, K, F>
    ): WithAddedPreloads<this, { [P in K]: PreloadRow<RowOf<X>, K, Q> | F }> {
        this.state.preloadEngine.preloadCb(this.preloadSubBuilder(relationName), relationName, cb, fallback);

        return this.__claim();
    }

    /** See `preloadCb` for why the receiver is a type parameter. */
    public preloadCbMaybe<K extends PossiblePreloadKey<X, StateOf<this>['P']>, Q, F = never, Recv extends RelationBuilder<X, K> = RelationBuilder<X, K>>(
        relationName: K,
        cb: (q: Recv) => Q | void,
        fallback?: PreloadFallback<X, K, F>
    ): WithAddedPreloads<this, { [P in K]: PreloadRowMaybe<RowOf<X>, K, Q> | F }> {
        this.state.preloadEngine.preloadCbMaybe(this.preloadSubBuilder(relationName), relationName, cb, fallback);

        return this.__claim();
    }

    /**
     * The sub-builder a preload runs on: a fresh instance of the preload class for the relation's model. The relation
     * resolves to a loose `OrmModel`, so `relation` is what states the surface every use is then checked against —
     * nothing is called through the assertion below, and the target is a real type.
     */
    protected preloadSubBuilder<K extends RelationKeyOf<X>>(relation: K): RelationBuilder<X, K> {
        const related = helpers.getRelationFor(this.model, relation).relatedModel();
        const sub = new PreloadQueryBuilder(related);
        this.adoptStateInto(sub);

        return sub as unknown as RelationBuilder<X, K>;
    }

    /** Counts a relation: `withCount('comments')` → `comments_count`, `withCount('comments', 'total')`, or a callback
     * that filters the count and names it: `withCount('comments', (c) => c.where('approved', 1).as('approved_count'))`.
     * A callback that RETURNS an alias string names the column too; one that just chains keeps `<relation>_count`. */
    public withCount<K extends PossibleCountsKey<X, StateOf<this>['C']>>(relationName: K): WithAddedCounts<this, RelationCount<K>>;
    public withCount<K extends PossibleCountsKey<X, StateOf<this>['C']>, A extends string>(relationName: K, alias: A): WithAddedCounts<this, AliasCount<A>>;
    public withCount<K extends PossibleCountsKey<X, StateOf<this>['C']>, A extends string>(
        relationName: K,
        cb: (q: CountQueryBuilder<RelationModelOf<RowOf<X>, K>> & SoftDeleteToggles<RelationModelOf<RowOf<X>, K>>) => A
    ): WithAddedCounts<this, AliasCount<A>>;
    public withCount<K extends PossibleCountsKey<X, StateOf<this>['C']>>(
        relationName: K,
        cb: (q: CountQueryBuilder<RelationModelOf<RowOf<X>, K>> & SoftDeleteToggles<RelationModelOf<RowOf<X>, K>>) => unknown
    ): WithAddedCounts<this, RelationCount<K>>;
    public withCount<K extends PossibleCountsKey<X, StateOf<this>['C']>, A extends string = never>(
        relationName: K,
        cbOrAlias?: ((q: CountSubquery) => unknown) | A
    ): WithAddedCounts<this, CountsOf<K, A>> {
        const relation = helpers.getRelationFor(this.model, relationName);
        const child = this.countSubquery(relation.relatedModel());
        const returned = typeof cbOrAlias === 'function' ? cbOrAlias(child) : undefined;

        this.state.countEngine.add(relationName, countAliasOf(cbOrAlias, child, returned), child.__internals().whereEngine.all(), child.__internals().enableSoftDeleteGuard);
        return this.__claim();
    }

    /**
     * `withCount` for a helper whose model parameter is generic: it cannot name the relation's child columns, so the
     * callback is handed the loose `CountSubquery` view instead of the typed `CountQueryBuilder`. Public because such
     * a helper narrows `this` to a relation subquery, which cannot reach a protected member. Returns the counts it
     * added, so a helper can accumulate them by chaining rather than asserting its own return type.
     */
    public withCountUnchecked<K extends string, A extends string = never>(relationName: K, cbOrAlias?: ((q: CountSubquery) => A) | A): WithAddedCounts<this, CountsOf<K, A>> {
        const relation = helpers.getRelationFor(this.model, relationName);
        const child = this.countSubquery(relation.relatedModel());
        const returned = typeof cbOrAlias === 'function' ? cbOrAlias(child) : undefined;

        this.state.countEngine.add(relationName, countAliasOf(cbOrAlias, child, returned), child.__internals().whereEngine.all(), child.__internals().enableSoftDeleteGuard);

        return this.__claim();
    }

    /**
     * The count subquery a callback filters. It gets its OWN builder, spawned here rather than through `makeBuilder`,
     * so the count surface — the alias — stays off the chain and no other flavour can call it. The statement's
     * soft-delete state and transaction flow in.
     */
    protected countSubquery<M extends OrmModel>(model: M): CountQueryBuilder<M> {
        const child = new CountQueryBuilder<M>(model);
        this.adoptStateInto(child);

        return child;
    }
}

/**
 * The preload flavour: the projection surface plus `paginating`, which is the whole of what a preload callback can do
 * that no other flavour can. Declared beside the surface it extends because this is the module that spawns it — the
 * preload engine itself is constructed by the shared builder base, so a module of its own would close an import cycle
 * (base → engine → flavour → base).
 */
export class PreloadQueryBuilder<X extends OrmModel> extends SubqueryBuilder<X> {
    /** Marks this preload paginated: `perPage` per page, `getPage` answering the page being fetched. */
    public paginating(perPage: number, getPage?: () => number): this & { readonly __paginated: true } {
        this.state.preloadEngine.paginating(perPage, getPage);

        return this.__claim();
    }
}
