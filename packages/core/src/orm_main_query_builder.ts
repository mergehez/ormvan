/**
 * The main-query flavour: what only a standalone query can do — `toSQL`, the transaction it runs through, the joins,
 * the hooks it skips — plus the members that execute SQL. A callback is handed `RelationSubquery`,
 * `SubqueryBuilder` or `CountQuery` instead, so it cannot run a query of its own.
 */
import type { OrmQueryable } from './executor.ts';
import {
    appOnlyStack,
    sqlAs,
    type Cols,
    type ColsOf,
    type ModelBuilder,
    type ModelColumn,
    type Obj,
    type OrmBuilderRow,
    type PossibleCountsKey,
    type RelatedModel,
    type RelationKeyOf,
    type RelationModelOf,
    type RowOf,
} from './orm_builder.ts';
import { ormConfig } from './orm_config.ts';
import { countAliasOf } from './orm_count.ts';
import type { CountQueryBuilder } from './orm_count_query_builder.ts';

import { OrmRowNotFoundError } from './orm_errors.ts';
import { modelHelpers as helpers, modelMeta, type RawSqlSubquery, type SqlSubquery } from './orm_helpers.ts';
import {
    runAfterDelete,
    runAfterRead,
    runBeforeDelete,
    runBeforeRead,
    runBeforeUpdate,
    type OrmDeleteHookContext,
    type OrmHookContext,
    type OrmHookName,
    type OrmReadHookContext,
    type OrmReadPhase,
} from './orm_hooks.ts';
import type { OrmModel } from './orm_model_contract.ts';
import { compareAndUpdateOrmRow, createMutableRow, type Mutable } from './orm_mutable.ts';
import { createPagination } from './orm_pagination.ts';
import type { AliasCount, StateOf, WithAddedExtras } from './orm_rebuild.ts';
import { softDeletePlan, type SoftDeletable, type SoftDeleteActor, type SoftDeleteExtra, type SoftDeletePlan } from './orm_soft_delete.ts';
import {
    deleteSql,
    explainSql,
    insertManySql,
    insertSelectSql,
    insertSql,
    onDuplicateKeyUpdate,
    quoteId,
    replaceIntoSql,
    resultHeader,
    updateSetSql,
    updateSql,
} from './orm_sql.ts';
import { SubqueryBuilder, type JoinOperator } from './orm_subquery_builder.ts';
import { isSqlValue, isSubqueryBuilder, type SqlValue } from './orm_where.ts';
import type { InsertUpdatePayload, OrmCreateData, OrmUpdateData, RowSource, UpdatePayload } from './orm_write.ts';

/** The main-query flavour. */
export abstract class MainQueryBuilder<X extends OrmModel> extends SubqueryBuilder<X> {
    /** Hook names this statement skips (`withoutHooks`), and whether the statement locks its rows (`forUpdate`).
     * Both describe the statement itself, so they live with the members that build and run it — and stay off the
     * chain's surface, where only the methods that set them belong. */
    protected skippedHooks = new Set<OrmHookName>();
    protected forUpdateValue = false;
    /** `UNION` members, in the order they were added (`union()`). A statement, not state: a sub-builder must not
     * inherit it, and neither must a preload. */
    protected unionParts: { sql: string; bindings: readonly unknown[]; all: boolean }[] = [];

    /**
     * Skips hooks by name for THIS statement:
     *
     * ```ts
     * await Book.orm().whereIn('id', ids).withoutHooks('beforeUpdate').updateAll({ rating: ratingOf('id') });
     * ```
     */
    public withoutHooks(...names: OrmHookName[]): this {
        for (const name of names) this.skippedHooks.add(name);
        return this;
    }

    /**
     * Runs this builder — and everything it spawns (preloads, counts, whereHas) — on `client`, which puts the
     * whole chain inside a transaction:
     *
     * ```ts
     * await Orm.transaction((tx) => Game.orm(tx).where('id', id).first());
     * ```
     */
    public withClient(client: OrmQueryable): this {
        this.state.client = client;
        return this;
    }

    /** The queryable this builder runs through: the caller's transaction, else the app's own executor. */
    protected queryable(): OrmQueryable {
        return this.state.client ?? ormConfig().getExecutor();
    }

    /** Runs a read through this builder's queryable. */
    protected runQuery(sql: string, bindings: readonly unknown[]): Promise<Obj[]> {
        return this.queryable().query(sql, bindings);
    }

    /** Runs a write through this builder's queryable. */
    protected async runExec(sql: string, bindings: readonly unknown[]): Promise<unknown> {
        try {
            return await this.queryable().exec(sql, bindings);
        } catch (error) {
            console.error('Error executing SQL:', sql, 'with bindings:', bindings);
            throw error;
        }
    }

    /** What an insert or restore hook receives: the transaction, the clock, and the statement's skip set. */
    protected hookCtx(): OrmHookContext {
        return {
            client: this.state.client,
            now: () => ormConfig().now(),
            withoutHooks: this.skippedHooks,
            // One call per statement for everything but a delete, which walks its rows (see `deleteRows`).
            isFirstCall: true,
            isLastCall: true,
        };
    }

    /** What a read hook receives: the same, plus which read this is. */
    protected readCtx(phase: OrmReadPhase): OrmReadHookContext {
        return { ...this.hookCtx(), phase };
    }

    /**
     * What a delete hook receives for one row: whether the row is MARKED, the actor it is attributed to, and where
     * this call sits in the statement.
     */
    protected deleteCtx(plan: SoftDeletePlan, by: SoftDeleteActor, index: number, total: number): OrmDeleteHookContext {
        return {
            ...this.hookCtx(),
            softDelete: plan !== null,
            deletedBy: plan ? by : null,
            isFirstCall: index === 0,
            isLastCall: index === total - 1,
        };
    }

    /** Joins a subquery builder/raw SQL as a derived table: `... <type> JOIN (<sub>) alias ON left op right`. */
    public joinSub(
        subquery: SqlSubquery | RawSqlSubquery,
        alias: string,
        left: ColsOf<X> | string | { sql: string },
        operator: JoinOperator = '=',
        right: string | { sql: string },
        type: 'INNER' | 'LEFT' | 'RIGHT' = 'INNER'
    ) {
        const leftColRef = typeof left !== 'string' ? left.sql : left.includes('.') ? left : `${this.state.tableName}.${left}`;
        const rightColRef = typeof right === 'string' ? right : right.sql;

        const compiled = 'toSQL' in subquery ? subquery.toSQL() : { sql: subquery.sql, bindings: subquery.bindings ?? [] };
        this.state.joinClauses.push({
            sql: `${type} JOIN (${compiled.sql}) ${alias} ON ${leftColRef} ${operator} ${rightColRef}`,
            bindings: compiled.bindings ?? [],
        });
        return this;
    }

    /** Convenience helper for the common `rightJoinSub` pattern. */
    public rightJoinSub(
        subquery: SqlSubquery | RawSqlSubquery,
        alias: string,
        left: ColsOf<X> | string | { sql: string },
        operator: JoinOperator = '=',
        right: string | { sql: string }
    ) {
        return this.joinSub(subquery, alias, left, operator, right, 'RIGHT');
    }

    /** `LEFT JOIN` a derived table — so all three of `joinSub`'s types have a name of their own. */
    public leftJoinSub(
        subquery: SqlSubquery | RawSqlSubquery,
        alias: string,
        left: ColsOf<X> | string | { sql: string },
        operator: JoinOperator = '=',
        right: string | { sql: string }
    ) {
        return this.joinSub(subquery, alias, left, operator, right, 'LEFT');
    }

    /**
     * Adds another query's rows to this one with `UNION`. The member must be the same chain type — same model, same
     * `select(...)` — so the two sides cannot disagree about the row shape:
     *
     * ```ts
     * await Entry.orm().select('id').where('status', 1)
     *     .union(Entry.orm().select('id').where('status', 2))
     *     .get();
     * ```
     *
     * The member compiles when it is passed, and each side keeps its own tail — an `ORDER BY`/`LIMIT` stays with the
     * query it was set on, which is also the only form MySQL accepts it in.
     */
    public union(member: this): this {
        return this.addUnion(member, false);
    }

    /** `UNION ALL` — `union()` without the duplicate removal. */
    public unionAll(member: this): this {
        return this.addUnion(member, true);
    }

    private addUnion(member: this, all: boolean): this {
        const { sql, bindings } = member.toSQL();
        this.unionParts.push({ sql, bindings, all });
        return this;
    }

    /** The `as` name of each selected item, in order (`undefined` where an item has no alias) — what an `INSERT … SELECT` reads its target columns from. */
    public selectedAliases(): (string | undefined)[] {
        return this.state.selectEngine.aliases();
    }

    /**
     * Builds the main query. `combineLateQueries` (tests only) appends the deferred paginated-preload SQL as
     * diagnostic fragments.
     */
    public toSQL(combineLateQueries = false) {
        const {
            countEngine,
            groupByClauses,
            havings,
            joinClauses,
            limitValue,
            offsetValue,
            orderByClauses,
            preloadEngine,
            selectEngine,
            selectedHiddenColumns,
            tableName,
            whereEngine,
        } = this.state;

        const selectClause = [selectEngine.selectList(this.model, selectedHiddenColumns), ...this.joinedColumns()];

        // Preloads, one JSON aggregate per relation.
        const preloadBindings: any[] = [];
        selectClause.push(...preloadEngine.getCompiledPreloadSqls(this.model, tableName, preloadBindings).map((c) => `${c.sql} AS ${c.relationName}`));

        const countBindings: any[] = [];
        selectClause.push(...countEngine.compileAll(this.model, tableName, countBindings));

        let sql = `SELECT\n  ${selectClause.join(',\n  ')}\nFROM ${tableName}`;

        if (joinClauses.length > 0) {
            sql += `\n${joinClauses.map((j) => j.sql).join('\n')}`;
        }

        const where = this.compileWhere();
        if (where) {
            sql += `\nWHERE ${where}`;
        }

        const tail = helpers.renderTailClauses(groupByClauses, havings, orderByClauses, limitValue, offsetValue);
        sql += tail.sql;

        // Last clause of the statement, so the tail's own order is untouched.
        if (this.forUpdateValue) {
            sql += '\nFOR UPDATE';
        }

        // A union is a statement of its own around this one, parenthesized so each side keeps its tail — MySQL only
        // accepts an ORDER BY/LIMIT inside the member it belongs to.
        if (this.unionParts.length > 0) {
            sql = `(${sql})${this.unionParts.map((part) => `\n${part.all ? 'UNION ALL' : 'UNION'} (${part.sql})`).join('')}`;
        }

        const lateBindings: any[] = [];
        if (combineLateQueries) {
            const lateSql = preloadEngine.getCompiledLatePreloadSqls(this.model, tableName, lateBindings).map((c) => c.sql);
            if (lateSql.length > 0) {
                sql = [sql, ...lateSql].join('\n\n');
            }
        }

        const bindings = [
            ...selectEngine.bindings(),
            ...preloadBindings,
            ...countBindings,
            ...joinClauses.flatMap((j) => j.bindings),
            ...whereEngine.bindings(),
            ...tail.bindings,
            ...this.unionParts.flatMap((part) => part.bindings),
            ...lateBindings,
        ];
        function bindParamsToSql() {
            let i = 0;
            return sql.replace(/\?/g, () => {
                const val = bindings[i++];
                if (val === null || val === undefined) return 'NULL';
                if (typeof val === 'number') return val.toString();
                if (typeof val === 'boolean') return val ? '1' : '0';
                if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                if (val instanceof Date) return `'${val.toISOString().slice(0, 19).replace('T', ' ')}'`;
                throw new Error(`Unsupported binding type: ${typeof val}`);
            });
        }

        return {
            sql,
            bindings,
            bindParamsToSql,
        };
    }

    /** `FOR UPDATE`: locks the selected rows until the transaction ends. A subquery cannot lock, so it lives here. */
    public forUpdate(): this {
        this.forUpdateValue = true;
        return this;
    }

    /**
     * Starts a query on `parent`'s `relationName`, pre-filtered to that parent's rows:
     * `User.orm().related('posts', user)`. hasMany/hasOne/belongsTo only — a through/pivot relation needs a query
     * of its own. It starts a separate statement, which is why it is not on the shared chain.
     */
    public related<K extends RelationKeyOf<X>>(relationName: K, parent: Pick<RowOf<X>, Cols<RowOf<X>> & keyof RowOf<X>>): ModelBuilder<RelatedModel<X, K>> {
        const relation = helpers.getRelationFor(this.model, relationName);
        const relatedModel = relation.relatedModel();
        const b = this.makeBuilder(relatedModel as RelatedModel<X, K>);

        if (relation.type === 'hasManyThrough' || relation.type === 'manyToMany') {
            throw new Error(`related('${relationName}') is not supported for ${relation.type} — query the table on the other side of the pivot/through model instead`);
        }

        // hasMany/hasOne: child.<foreignKey> = parent.<localKey>; belongsTo is reversed
        const { localKey, foreignKey } = helpers.getRelationKeys(relation, this.model);
        const parentCol = relation.type === 'belongsTo' ? foreignKey : localKey;
        const childCol = relation.type === 'belongsTo' ? localKey : foreignKey;

        const value = (parent as Obj)[parentCol];
        const { tableName, whereEngine } = b.__internals();
        whereEngine.addRaw(`${tableName}.${childCol} = ?`, [value]);
        return b;
    }

    /**
     * Counts a relation AND orders by that count: the count runs once per child row in a derived table, and the
     * parent joins back to the top-`limit` counts. It joins into THIS statement, so it is main-only.
     *
     * The alias is an extra row key, not a projection: the caller's `select(...)` still decides the columns (and
     * both end up in the SELECT list, which is why the extras survive it).
     */
    public withCountOrdered<K extends PossibleCountsKey<X, StateOf<this>['C']>, A extends string = `${K}_count`>(
        relationName: K,
        cbOrAlias?: ((q: CountQueryBuilder<RelationModelOf<RowOf<X>, K>>) => A | void) | A,
        limit: number = 50
    ): WithAddedExtras<this, AliasCount<A>> {
        const relation = helpers.getRelationFor(this.model, relationName);
        const { localKey, foreignKey } = helpers.getRelationKeys(relation, this.model);
        // The derived table groups by the child's FK; the parent joins back on its PK.
        const parentCol = relation.type === 'belongsTo' ? foreignKey : localKey;
        const childCol = relation.type === 'belongsTo' ? localKey : foreignKey;

        const child = this.countSubquery(relation.relatedModel() as RelationModelOf<RowOf<X>, K>);
        const returned = typeof cbOrAlias === 'function' ? cbOrAlias(child) : undefined;
        const alias = countAliasOf(cbOrAlias, child, returned) ?? `${relationName}_count`;

        const sub = this.makeBuilder(relation.relatedModel())
            .select(sqlAs('COUNT(*)', alias, 0), `${childCol}` as never)
            .groupBy(`${childCol}` as never)
            .orderBy({ sql: alias }, 'desc')
            .limit(limit);
        // The count's WHERE is the callback's, so its soft-delete decision comes with it.
        sub.__internals().enableSoftDeleteGuard = child.__internals().enableSoftDeleteGuard;
        for (const w of [...this.relationOnQuery(relation), ...child.__internals().whereEngine.all()]) {
            sub.__internals().whereEngine.addRaw(w.sql, w.bindings, w.boolean);
        }

        return this.joinSub(sub, 'rc', `${this.state.tableName}.${parentCol}`, '=', `rc.${childCol}`)
            .orderBy({ sql: `rc.${alias}` }, 'desc')
            .select(sqlAs(`rc.${alias}`, alias, 0))
            .__claim();
    }
    public async get<T extends this>(this: T, logSql = false) {
        const hookCtx = this.readCtx('get');
        await runBeforeRead(this.model, this, hookCtx);
        const rows = await this.fetchRows(logSql);
        await runAfterRead(this.model, rows, hookCtx);
        return rows as OrmBuilderRow<T>[];
    }

    /**
     * Compiles and runs this query, late preloads included — the read hooks are the caller's. `paginate()` runs two
     * statements under ONE pair of hooks, so it cannot go through `get()`.
     */
    private async fetchRows(logSql: boolean): Promise<Obj[]> {
        const sql = this.toSQL();

        if (this.initiatedFrom) {
            console.log(`Orm.get() initiated at: ${this.initiatedFrom}`);
            console.log(`Orm.get() submitted at: ${appOnlyStack(1)}`);
        }
        if (logSql) {
            console.log(sql.bindParamsToSql());
        }
        const rows = await this.runQuery(sql.sql, sql.bindings);
        // Deferred (paginating) preloads run AFTER the main query, one IN query per relation.
        if (this.state.preloadEngine.hasLatePreloads()) {
            await this.state.preloadEngine.runLatePreloads(this.model, rows);
        }
        return rows;
    }

    public async getMap<T extends this, R>(this: T, map: (row: OrmBuilderRow<T>) => R): Promise<R[]> {
        const res = await this.get();
        return res.map(map);
    }

    /** `get()` with every row mutable — change a field and call `save()` on it. */
    public async getMutable<T extends this>(this: T, logSql = false): Promise<Array<Mutable<OrmBuilderRow<T>>>> {
        const rows = await this.get(logSql);
        return rows.map((row) => createMutableRow(this, this.primaryKey, row));
    }

    // for debug. do not delete
    public _fakeFirst<T extends this>(this: T) {
        return null as unknown as OrmBuilderRow<T>;
    }

    // private makeMutable<Row>(row: Row) {
    // return createMutableRow(this as Orm<X, TSelected, TPreloads, TCounts, TExtras>, row);
    // }

    /** The first matching row, as plain data. `logSql` prints the statement it ran. */
    public async first<T extends this>(this: T, logSql = false): Promise<OrmBuilderRow<T> | null> {
        const { preloadEngine, tableName } = this.state;
        const hookCtx = this.readCtx('first');
        await runBeforeRead(this.model, this, hookCtx);
        this.limit(1);
        const sql = this.toSQL();

        if (logSql) {
            console.log('[Orm.first()] SQL:', sql.bindParamsToSql());
        }

        const rows = await this.runQuery(sql.sql, sql.bindings);
        let row = rows[0] ?? null;
        // Deferred (paginating) preloads run AFTER the main query.
        if (row && preloadEngine.hasLatePreloads()) {
            if (logSql) {
                console.log('\n\nLate SQLs:', preloadEngine.getCompiledLatePreloadSqls(this.model, tableName, sql.bindings));
            }
            await preloadEngine.runLatePreloads(this.model, [row]);
        }
        if (row) {
            const hooked = [row];
            await runAfterRead(this.model, hooked, hookCtx);
            row = hooked[0];
        }

        return row as OrmBuilderRow<T> | null;
    }

    /** `first()`, as a row that can be changed and saved — `save(ctx)` writes the dirty columns. */
    public async firstMutable<T extends this>(this: T, logSql = false): Promise<Mutable<OrmBuilderRow<T>> | null> {
        const row = await this.first(logSql);
        if (!row) return null;
        return createMutableRow(this, this.primaryKey, row);
    }

    /** Same as `first()`, but throws `OrmRowNotFoundError` (a 404) when no row matches. */
    public async firstOrFail<T extends this>(this: T, logSql = false): Promise<OrmBuilderRow<T>> {
        const row = await this.first(logSql);
        if (!row) {
            throw new OrmRowNotFoundError(this.model);
        }
        return row;
    }

    /** Same as `firstMutable()`, but throws `OrmRowNotFoundError` when no row matches. */
    public async firstOrFailMutable<T extends this>(this: T, logSql = false): Promise<Mutable<OrmBuilderRow<T>>> {
        const row = await this.firstMutable(logSql);
        if (!row) {
            throw new OrmRowNotFoundError(this.model);
        }
        return row;
    }

    public async firstMap<T extends this, R>(this: T, map: (row: OrmBuilderRow<T>) => R) {
        const res = await this.first();
        return res ? map(res) : res;
    }

    /** One column of the first matching row, or the fallback (`null` by default) when nothing matches. */
    public async firstCol<T extends this, Col extends ColsOf<X>, Or = null>(this: T, column: Col, falback: Or = null as Or) {
        this.select(column);
        const res = await this.first();
        return res ? ((res as Record<Col, unknown>)[column] as Or) : falback;
    }

    public async find<T extends this>(this: T, pkValue: number | string, logSql = false) {
        this.where(this.primaryKey, pkValue);
        return await this.first(logSql);
    }

    /** `find()` as a row that can be changed and saved — the primary-key shorthand for `firstMutable()`. */
    public async findMutable<T extends this>(this: T, pkValue: number | string, logSql = false) {
        this.where(this.primaryKey, pkValue);
        return await this.firstMutable(logSql);
    }

    /** Same as `find()`, but throws `OrmRowNotFoundError` when no row matches. */
    public async findOrFail<T extends this>(this: T, pkValue: number | string, logSql = false) {
        const row = await this.find(pkValue, logSql);
        if (!row) {
            throw new OrmRowNotFoundError(this.model);
        }
        return row;
    }

    /** Same as `findMutable()`, but throws `OrmRowNotFoundError` when no row matches. */
    public async findOrFailMutable<T extends this>(this: T, pkValue: number | string, logSql = false) {
        const row = await this.findMutable(pkValue, logSql);
        if (!row) {
            throw new OrmRowNotFoundError(this.model);
        }
        return row;
    }

    /** Runs `SELECT COUNT(*)` honoring the current WHERE — `countSql()` with an alias, so the value reads back by name. */
    public async count(): Promise<number> {
        await runBeforeRead(this.model, this, this.readCtx('count'));
        return await this.countRows();
    }

    /** The count itself — no hooks, because `paginate()` already fired them for this statement. */
    private async countRows(): Promise<number> {
        const { sql, bindings } = this.countSql('total');

        const rows = await this.runQuery(sql, bindings ?? []);
        return Number(rows[0]?.total ?? 0);
    }

    /**
     * This builder as a counter *value*: `SELECT COUNT(*) FROM … WHERE …`, soft-delete scope applied, with any
     * `q.ref(...)` in its WHERE inlined so it stays correlated to the row being written.
     */
    public countSql(alias?: string): SqlValue {
        const { tableName, whereEngine } = this.state;
        const where = this.compileWhere();

        // A union is not a table, so the count wraps the whole statement instead: `SELECT COUNT(*) FROM (…) AS t`.
        if (this.unionParts.length > 0) {
            const { sql, bindings } = this.toSQL();
            return { sql: `SELECT COUNT(*)${alias ? ` AS ${alias}` : ''} FROM (${sql}) AS t`, bindings };
        }

        return {
            sql: `SELECT COUNT(*)${alias ? ` AS ${alias}` : ''} FROM ${tableName}${where ? ` WHERE ${where}` : ''}`,
            bindings: whereEngine.bindings(),
        };
    }

    /** Runs `SELECT COUNT(DISTINCT col) AS <alias>` honoring the current WHERE. */
    public async countDistinct(column: ModelColumn<X>): Promise<Array<Record<'total', number>>>;
    public async countDistinct<A extends string>(column: ModelColumn<X>, alias: A): Promise<Array<Record<A, number>>>;
    public async countDistinct(column: ModelColumn<X>, alias: string = 'total') {
        const { tableName, whereEngine } = this.state;
        await runBeforeRead(this.model, this, this.readCtx('countDistinct'));
        let sql = `SELECT COUNT(DISTINCT ${tableName}.${column}) AS ${alias} FROM ${tableName}`;

        const where = this.compileWhere();
        if (where) {
            sql += `\nWHERE ${where}`;
        }

        const rows = await this.runQuery(sql, whereEngine.bindings());
        return rows as Array<Record<string, number>>;
    }

    /** Returns true when at least one row matches the current query (no row fetch — `SELECT EXISTS(...)`). */
    public async exists() {
        await runBeforeRead(this.model, this, this.readCtx('exists'));
        let sql = `SELECT EXISTS(SELECT 1 FROM ${this.state.tableName}`;

        const where = this.compileWhere();
        if (where) {
            sql += ` WHERE ${where}`;
        }
        sql += `) AS found`;

        const rows = await this.runQuery(sql, this.state.whereEngine.bindings());
        return !!rows[0]?.found;
    }

    /**
     * Runs MySQL `EXPLAIN` on this query's SQL and returns the plan rows. Returns `this`, or throws the DB error.
     */
    public async validateSql(): Promise<this> {
        const { sql, bindings } = this.toSQL();
        await this.runQuery(explainSql(sql), bindings);
        return this;
    }

    /** No-op that returns `this` typed as the concrete builder — lets a chain assert a stable type. */
    public check<T extends this>(this: T, _aa?: OrmBuilderRow<T>): T {
        return this;
    }

    /**
     * Pagination: `{ items, total, currentPage, perPage, lastPage, hasMorePages, … }`.
     *
     * It is two statements — the count and the page — but the read hooks fire **once** for both (`phase`
     * `'paginate'`), so a hook that narrows the query cannot run twice or reach one half only.
     */
    public async paginate<T extends this>(this: T, page: number, perPage: number = 20) {
        const currentPage = Math.max(1, page);

        if (this.initiatedFrom) {
            console.log(`Orm.paginate() initiated at: ${this.initiatedFrom}`);
            console.log(`Orm.paginate() submitted at: ${appOnlyStack(1)}`);
        }

        const hookCtx = this.readCtx('paginate');
        await runBeforeRead(this.model, this, hookCtx);
        const total = await this.countRows();
        const rows = await this.offset((currentPage - 1) * perPage)
            .limit(perPage)
            .fetchRows(false);
        await runAfterRead(this.model, rows, hookCtx);
        return createPagination(rows as OrmBuilderRow<T>[], total, currentPage, perPage);
    }

    /**
     * Writes through the engine's own SQL; the argument's shape decides the statement:
     *
     * ```ts
     * await ChatMessage.orm().insert({ receiver_id: 5, text: 'hi' });                     // one row, returns its key
     * await UserStatistics.orm().insert(User.orm().select(colAs('id', 'user_id')), true); // its rows, returns the count
     * ```
     */
    public async insert(data: InsertUpdatePayload | RowSource, useIgnore: boolean = false): Promise<number | string> {
        if (isSubqueryBuilder(data)) return this.insertFrom(data, useIgnore);

        const columns = this.meta.columns.filter((column) => data[column] !== undefined);
        if (!columns.length) {
            throw new Error(`Orm.insert() got no columns for '${this.state.tableName}'.`);
        }

        const { expressions, bindings } = this.prepareWrite(data, columns);
        const header = resultHeader(await this.runExec(insertSql(this.state.tableName, columns, useIgnore, expressions), bindings));

        return (data[this.primaryKey] ?? header.insertId) as number | string;
    }

    /**
     * Inserts SEVERAL rows in one statement — the batch form of `insert()`. Every row must carry the same set of
     * columns. Returns how many landed.
     */
    public async insertMany(rows: InsertUpdatePayload[], useIgnore: boolean = false): Promise<number> {
        const { tableName } = this.state;
        if (rows.length === 0) return 0;

        const columns = this.meta.columns.filter((column) => rows[0][column] !== undefined);
        if (!columns.length) {
            throw new Error(`Orm.insertMany() got no columns for '${tableName}'.`);
        }

        const bindings: unknown[] = [];
        const tuples = rows.map((row) => {
            const missing = columns.filter((column) => row[column] === undefined);
            if (missing.length) {
                throw new Error(
                    `Orm.insertMany() got a row for '${tableName}' missing ${missing.join(', ')} — every row must state the same columns (use \`null\` for an empty one).`
                );
            }

            const prepared = this.prepareWrite(row, columns);
            bindings.push(...prepared.bindings);

            return `(${prepared.expressions.join(', ')})`;
        });

        const header = resultHeader(await this.runExec(insertManySql(tableName, columns, tuples, useIgnore), bindings));

        return header.affectedRows ?? 0;
    }

    /** `INSERT [IGNORE ]INTO … (columns) SELECT …`, the columns being the select's own aliases in order. */
    private async insertFrom(select: RowSource, useIgnore: boolean): Promise<number> {
        const { tableName } = this.state;
        const aliases = select.selectedAliases?.() ?? [];
        const columns = aliases.filter((alias): alias is string => !!alias);
        if (!columns.length || columns.length !== aliases.length) {
            throw new Error(
                `Orm.insert() got a builder for '${tableName}' whose select does not name its columns: alias each item to the column it fills, e.g. \`colAs('id', 'user_id')\`.`
            );
        }
        const unknown = columns.filter((column) => !this.meta.columns.includes(column));
        if (unknown.length) {
            throw new Error(`Orm.insert() got a builder naming columns '${tableName}' does not have: ${unknown.join(', ')}.`);
        }

        const { sql, bindings } = select.toSQL();
        const header = resultHeader(await this.runExec(insertSelectSql(tableName, columns, useIgnore, sql), bindings ?? []));

        return header.affectedRows ?? 0;
    }

    /** Inserts ONE row via `REPLACE INTO`: unlike `upsert`, a conflict deletes the existing row first. */
    public async replaceInto(data: InsertUpdatePayload): Promise<number | string> {
        const columns = this.meta.columns.filter((column) => data[column] !== undefined);
        if (!columns.length) {
            throw new Error(`Orm.replaceInto() got no columns for '${this.state.tableName}'.`);
        }

        const { expressions, bindings } = this.prepareWrite(data, columns);
        const header = resultHeader(await this.runExec(replaceIntoSql(this.state.tableName, columns, expressions), bindings));

        return (data[this.primaryKey] ?? header.insertId) as number | string;
    }

    /** Updates ONE row by its primary key, writing only the columns given. Returns the rows affected. */
    public async update(pkValue: number | string, data: InsertUpdatePayload): Promise<number> {
        const columns = this.meta.columns.filter((column) => column !== this.primaryKey && data[column] !== undefined);
        if (!columns.length) return 0;

        const { expressions, bindings } = this.prepareWrite(data, columns);
        const header = resultHeader(await this.runExec(updateSql(this.state.tableName, columns, this.primaryKey, expressions), [...bindings, pkValue]));

        return header.affectedRows ?? 0;
    }

    /** The SQL value expression per column and the bindings in the same order. */
    private prepareWrite(data: InsertUpdatePayload, columns: readonly string[]): { expressions: string[]; bindings: unknown[] } {
        const expressions: string[] = [];
        const bindings: unknown[] = [];

        for (const column of columns) {
            const value = data[column];
            if (isSqlValue(value)) {
                // An inlined value is parenthesized so it reads as the scalar a written column wants — whether
                // it is an expression (`dbRaw('ROUND(…)')`) or a whole statement (`countSql()`).
                expressions.push(`(${value.sql})`);
                if (value.bindings) bindings.push(...value.bindings);
                continue;
            }

            if (isSubqueryBuilder(value)) {
                // A builder is inlined as it compiled — its own `select(...)` decides the scalar.
                const sub = value.toSQL();
                expressions.push(`(${sub.sql})`);
                if (sub.bindings) bindings.push(...sub.bindings);
                continue;
            }

            expressions.push('?');
            const prepare = this.meta.castPrepare.get(column);
            bindings.push(prepare ? prepare(value, column) : value);
        }

        return { expressions, bindings };
    }

    /**
     * Updates every row this query matches, in one statement. The WHERE is the whole query, so a bulk update
     * without one throws, and `afterUpdate` does not run.
     */
    public async updateAll(data: UpdatePayload<X>): Promise<number> {
        const { enableSoftDeleteGuard, tableName, whereEngine } = this.state;
        // A callback gets the updated row's own columns in reach, which is what a correlated subquery needs.
        const resolved = typeof data === 'function' ? data({ ref: (column) => ({ sql: `${tableName}.${column}`, bindings: [] }) }) : data;

        // Only real columns, the primary key excluded: a payload may carry computed props.
        const payload: InsertUpdatePayload = {};
        for (const column of this.meta.columns) {
            if (column !== this.primaryKey && resolved[column] !== undefined) payload[column] = resolved[column];
        }
        const intent = await runBeforeUpdate(this.model, payload, this.hookCtx());

        // The hook did the bulk work: nothing runs, and the count it hands back is what the caller gets.
        if (intent) return intent.done as number;

        const columns = this.meta.columns.filter((column) => column !== this.primaryKey && payload[column] !== undefined);
        if (!columns.length) return 0;

        const userWhere = whereEngine.compileWhereClauses();
        if (!userWhere) {
            console.log(updateSetSql(tableName, columns));
            throw new Error('Dangerous Operation: Bulk update attempted without a WHERE clause.');
        }

        const { expressions, bindings } = this.prepareWrite(payload, columns);

        // Like `delete()`: a soft-deletable model is scoped to live rows, and `withTrashed()` (or
        // `ignoreSoftDeleteGuard()`) removes the scope — the engine's reads already behave this way.
        const scope = enableSoftDeleteGuard ? helpers.softDeleteScope(this.model, tableName) : null;
        const sql = `${updateSetSql(tableName, columns, expressions)} WHERE ${scope ? `${scope} AND (${userWhere})` : userWhere}`;

        const affected = resultHeader(await this.runExec(sql, [...bindings, ...whereEngine.bindings()])).affectedRows ?? 0;
        return affected;
    }

    /**
     * Inserts the row, or updates the row holding its primary key, in one `INSERT ... ON DUPLICATE KEY UPDATE`:
     * columns missing from `data` keep the database's own value.
     */
    public async upsert<T extends this>(this: T, data: OrmUpdateData<X>): Promise<void> {
        const { tableName } = this.state;
        // Only real columns reach the SQL: a payload that carries a computed/unknown prop must
        // not put its key name in an INSERT (and nothing outside the model is writable).
        const mutableColumns = modelMeta(this.model).columns;
        const columns = Object.keys(data)
            .map(String)
            .filter((column) => mutableColumns.includes(column));
        if (!columns.length) {
            throw new Error(`Orm.upsert() got no columns for '${tableName}'.`);
        }

        const row = data as Obj;
        // One statement binds each column twice (the VALUES half and the ON DUPLICATE KEY UPDATE half), so an
        // inlined expression has nowhere to go — saying so beats binding `{ sql }` as a value.
        if (columns.some((column) => isSqlValue(row[column]) || isSubqueryBuilder(row[column]))) {
            throw new Error(`Orm.upsert() cannot write a raw expression for '${tableName}': the ON DUPLICATE KEY UPDATE half binds the same column twice.`);
        }
        const updates = columns.filter((column) => column !== this.primaryKey);
        let sql = insertSql(tableName, columns, false);
        // Nothing but the primary key was given: a plain insert is all there is to do.
        if (updates.length) {
            sql += onDuplicateKeyUpdate(updates);
        }

        await this.runExec(sql, [...columns.map((column) => row[column]), ...updates.map((column) => row[column])]);
    }

    /**
     * Updates the row matching `toCheck`, or inserts one. Returns the row as it now exists.
     *
     * Not `upsert()`: the lookup is an explicit SELECT, because the columns the caller names are not the only
     * unique index on the table.
     */
    public async upsertBy<T extends this>(this: T, toCheck: Obj, toUpdate: Obj, options?: { client?: OrmQueryable }): Promise<OrmBuilderRow<T>> {
        const checkColumns = this.meta.columns.filter((column) => toCheck[column] !== undefined);
        if (!checkColumns.length) {
            throw new Error(`Orm.upsertBy() needs at least one column to match on for '${this.state.tableName}'.`);
        }

        const builderClass = this.state.builderClass;
        const client = options?.client;
        if (client) this.withClient(client);

        for (const column of checkColumns) {
            this.where(column as ColsOf<X>, toCheck[column] as never);
        }
        const existing = await this.first();

        // The update path is what a mutable `save()` takes; the insert path is `ormCreate`.
        const row = existing
            ? await compareAndUpdateOrmRow(this.model, existing, { ...(existing as Obj), ...toCheck, ...toUpdate }, undefined, builderClass, client)
            : await builderClass.create(this.model, { ...toCheck, ...toUpdate } as OrmCreateData<X>, options);

        return row as OrmBuilderRow<T>;
    }
    /**
     * Deletes every row this query matches, and returns how many went. The actor is asked for only where a soft
     * delete writes it down: a soft-deletable model's `delete(byId, extra?)` records it in `deleted_by`, and every
     * other model's `delete()` takes nothing — there is no column it could reach. `extra` names further columns to
     * write in the same statement, so a "why" column can never disagree with the mark that hid the row.
     *
     * A model that declares `beforeDelete`/`afterDelete` is deleted **one row per statement**, so the hooks see the
     * row they are about to remove (or just removed); skipping every declared one (`withoutHooks`) asks for the single
     * bulk statement instead.
     */
    public async delete(...args: SoftDeletable<X> extends true ? [deleteById: SoftDeleteActor, extra?: SoftDeleteExtra<X>] : []): Promise<number> {
        const [deleteById = null, extra] = args as [SoftDeleteActor, SoftDeleteExtra<X>?];
        // Built once: every row of this statement carries the same stamp and the same actor.
        const plan = this.softDeletePlan(deleteById, extra);
        const unskipped = helpers.deleteHooks(this.model).filter((hook) => !this.skippedHooks?.has(hook));

        return unskipped.length > 0 ? this.deleteRows(deleteById, plan) : this.deleteStatement(plan);
    }

    /** The soft-delete statement this chain would run, or `null` when the rows are removed for real. */
    private softDeletePlan(deleteById: SoftDeleteActor, extra?: SoftDeleteExtra<X>): SoftDeletePlan {
        const { enableSoftDeleteGuard, tableName } = this.state;
        return softDeletePlan(this.model, tableName, deleteById, ormConfig().now(), enableSoftDeleteGuard, extra);
    }

    /**
     * The rows are read first and every `beforeDelete` runs before a single write, so a hook can stop the whole delete
     * by throwing — with nothing deleted — or keep its own row by returning `false`.
     */
    private async deleteRows(deleteById: SoftDeleteActor, plan: SoftDeletePlan): Promise<number> {
        // The rows come from the WHERE the single statement would use, so an unscoped delete is refused here too —
        // before a row is read and before a hook sees one.
        if (!this.state.whereEngine.compileWhereClauses()) {
            throw new Error('Dangerous Operation: Bulk delete attempted without a WHERE clause.');
        }

        const rows = await this.rowsForDelete();
        const kept = new Set<number>();
        // Every hook runs before the first write, so one that throws stops the delete with nothing written.
        for (const [index, row] of rows.entries()) {
            if ((await runBeforeDelete(this.model, row, this.deleteCtx(plan, deleteById, index, rows.length))) === false) kept.add(index);
        }

        const going = rows.filter((_row, index) => !kept.has(index));
        let affected = 0;
        for (const [index, row] of going.entries()) {
            affected += await this.deleteStatement(plan, row[this.primaryKey]);
            await runAfterDelete(this.model, row, this.deleteCtx(plan, deleteById, index, going.length));
        }
        return affected;
    }

    /**
     * The rows this delete matches, read with the model's own columns: a hook decides on a column, so the chain's own
     * `select(...)` must not hide one from it.
     */
    private async rowsForDelete(): Promise<Obj[]> {
        const selected = this.state.selectEngine.all();
        this.state.selectEngine.replaceAll([]);
        try {
            return await this.fetchRows(false);
        } finally {
            this.state.selectEngine.replaceAll(selected);
        }
    }

    /**
     * The delete statement itself: every row this query matches, or the one row `pk` names. The WHERE is the whole
     * scope, so a statement with neither throws, and the hooks are the caller's business.
     */
    private async deleteStatement(plan: SoftDeletePlan, pk?: unknown): Promise<number> {
        const { tableName, whereEngine } = this.state;

        // Soft delete vs hard delete lives in `orm_soft_delete.ts`: a model with a config becomes an UPDATE
        // of its own columns, scoped to live rows; anything else is a real DELETE FROM.

        const userWhere = whereEngine.compileWhereClauses();
        if (!userWhere) {
            console.log(plan?.sql ?? deleteSql(tableName));
            throw new Error('Dangerous Operation: Bulk delete attempted without a WHERE clause.');
        }

        // mysql2 rawQuery: `?` placeholders — the statement's own values (SET) first, then the WHERE's.
        const sql = plan?.sql ?? deleteSql(tableName);
        const pkWhere = pk === undefined ? null : `${quoteId(tableName)}.${quoteId(this.primaryKey)} = ?`;
        const narrowed = pkWhere ? `${pkWhere} AND (${userWhere})` : userWhere;
        const where = plan ? `${plan.scope} AND (${narrowed})` : narrowed;
        console.log(`${sql} WHERE ${where}`);

        const bindings = [...(plan?.bindings ?? []), ...(pkWhere ? [pk] : []), ...whereEngine.bindings()];
        return resultHeader(await this.runExec(`${sql} WHERE ${where}`, bindings)).affectedRows ?? 0;
    }

    /**
     * Un-deletes every row this query matches, in one statement — the other half of a soft delete. The query's
     * own WHERE is the whole scope, so an unscoped restore is refused.
     */
    public async deleteBy(pkValue: unknown, ...args: SoftDeletable<X> extends true ? [deleteById: SoftDeleteActor, extra?: SoftDeleteExtra<X>] : []) {
        return this.where(this.primaryKey, pkValue).delete(...args);
    }
}
