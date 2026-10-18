import type { OrmExecutor, OrmQueryable } from './executor.ts';
import type { ColsOf, HiddenOf, IsToManyRelation, ModelBuilder, ModelOfRelation, Obj, OrmBuilderRow, OrmRow, RelationKeys, RowOf } from './orm_builder.ts';
import { configureOrm, ormConfig, type OrmConfig } from './orm_config.ts';
import type { OrmContext } from './orm_context.ts';
import { ConvertNullable } from './orm_helpers.ts';
import { runAfterInsert, runBeforeInsert, type OrmHookContext } from './orm_hooks.ts';
import { MainQueryBuilder } from './orm_main_query_builder.ts';
import { OrmModel } from './orm_model_contract.ts';
import { compareAndUpdateOrmRow, createMutableRow, type Mutable } from './orm_mutable.ts';
import { foreignKeyChecksSql } from './orm_sql.ts';
import type { OrmCreateData, OrmUpdateData } from './orm_write.ts';

export * from './orm_builder.ts';
export * from './orm_preload.ts';

/**
 * A write payload: column → value. A value is bound (with the column's cast applied) unless the database has to
 * compute it: `dbRaw(...)` is inlined as an expression, and a **builder** becomes a subquery inlined as it
 * compiled, so its select list decides the scalar.
 */

/** `OrmRow` plus hidden columns: all of them by default, or an explicit subset of `Keys`. */
export type OrmRowWithHidden<TModel extends OrmModel, Keys extends HiddenOf<TModel> = HiddenOf<TModel>> = ConvertNullable<
    Pick<RowOf<TModel>, (ColsOf<TModel> | (Keys & keyof RowOf<TModel>)) & keyof RowOf<TModel>> & Pick<TModel, Extract<Keys, keyof TModel>>
>;
type RelatedRowValue<Relation> = IsToManyRelation<Relation> extends true ? Array<OrmRow<ModelOfRelation<Relation>>> : OrmRow<ModelOfRelation<Relation>>;
export type OrmRowWithRelations<TModel extends OrmModel, TRelations extends RelationKeys<RowOf<TModel>>> = OrmRow<TModel> & {
    [K in TRelations]: RelatedRowValue<RowOf<TModel>[K]>;
};
/**
 * The four calls of `Orm.withConnection(executor)`, on a connection that is not the app's default.
 */
export type OrmConnection = {
    /** Runs a statement on this connection and returns every row. */
    runQuery<Row extends Obj = Obj>(sql: string, bindings?: readonly unknown[]): Promise<Row[]>;
    /** Runs a statement on this connection and returns the first row, or `null`. */
    runFirst<Row extends Obj = Obj>(sql: string, bindings?: readonly unknown[]): Promise<Row | null>;
    /** Runs a write on this connection and returns the driver's raw result. */
    runExec(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
    /** Opens a transaction on this connection. */
    transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T>;
};

/** The surface `Orm.withConnection` hands back: the statics' four calls, aimed at one executor. */
function rawSurfaceOn(executor: OrmExecutor): OrmConnection {
    return {
        async runQuery<Row extends Obj>(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
            return (await executor.query(sql, bindings)) as Row[];
        },
        async runFirst<Row extends Obj>(sql: string, bindings: readonly unknown[] = []): Promise<Row | null> {
            const rows = (await executor.query(sql, bindings)) as Row[];

            return rows[0] ?? null;
        },
        runExec(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
            return executor.exec(sql, bindings);
        },
        transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            return executor.transaction(fn);
        },
    };
}

/**
 * The one class: the statics every entry point goes through, the configuration they read, and the chain class a
 * rebuild lands in. The query surface itself is `MainQueryBuilder`.
 *
 * ```ts
 * Orm.configure({
 *     getExecutor: (connectionName) => connections.executor(connectionName),
 *     now: () => dt.unix(),
 *     getAuthUser: (ctx) => authUser(ctx),
 * });
 * ```
 */
export class Orm<X extends OrmModel> extends MainQueryBuilder<X> {
    /**
     * Installs the app's configuration — where statements run, the clock, the acting user. Stored globally (see
     * `orm_config.ts`), so every builder reads it and no class has to be threaded through a chain. Called once, at
     * boot; the previous configuration is returned so a caller can put it back.
     */
    public static configure(config: Partial<OrmConfig>): OrmConfig {
        return configureOrm(config);
    }

    /** Entry point for every builder an app starts (`Model.orm(client?)`). */
    public static for<X extends OrmModel>(model: X) {
        return new Orm(model);
    }

    /** The clock that stamps `updated_at` on a save — the app's own (`dt.unix()`), from the configuration. */
    public static now(): number {
        return ormConfig().now();
    }

    /** Who a save attributes `updated_by` to — the app's own auth reader, from the configuration. */
    public static getAuthUser(ctx: OrmContext): { id: number } | undefined | null {
        return ormConfig().getAuthUser(ctx);
    }

    /** Where every statement runs. `connectionName` reaches a named connection. */
    public static getExecutor(connectionName?: string): OrmExecutor {
        return ormConfig().getExecutor(connectionName);
    }

    /** Runs raw SQL through the app's executor — the escape hatch for statements no model owns. */
    public static async runQuery<Row extends Obj = Obj>(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
        return (await Orm.getExecutor().query(sql, bindings)) as Row[];
    }

    /** The first row of a raw query, or `null`. */
    public static async runFirst<Row extends Obj = Obj>(sql: string, bindings: readonly unknown[] = []): Promise<Row | null> {
        const rows = (await Orm.getExecutor().query(sql, bindings)) as Row[];
        return rows[0] ?? null;
    }

    /** Runs a write through the app's executor, returning the driver's raw result. */
    public static runExec(sql: string, bindings: readonly unknown[] = []): Promise<unknown> {
        return Orm.getExecutor().exec(sql, bindings);
    }

    /**
     * Opens a transaction and hands `fn` its queryable; every statement run with that `tx` is part of it. Throwing
     * inside `fn` rolls everything back; the return value is `fn`'s.
     *
     * ```ts
     * await Orm.transaction(async (tx) => {
     *     await Game.orm(tx).where('id', id).upsert({ status: 'active' });
     * });
     * ```
     *
     * `disableForeignKeyChecks` turns MySQL's foreign-key checks off for the length of the transaction.
     */
    public static transaction<T>(fn: (tx: OrmQueryable) => Promise<T>, options?: { disableForeignKeyChecks?: boolean }): Promise<T> {
        return Orm.getExecutor().transaction(async (tx) => {
            if (!options?.disableForeignKeyChecks) return fn(tx);

            await tx.exec(foreignKeyChecksSql(false), []);
            try {
                return await fn(tx);
            } finally {
                await tx.exec(foreignKeyChecksSql(true), []);
            }
        });
    }

    /**
     * Something other than the app's default connection:
     *
     * ```ts
     * await Orm.withConnection('lyrics', RadioSong).where('id', id).first();
     * ```
     *
     * The name is resolved by the app's configuration (`getExecutor(connectionName)`); an executor may be passed
     * instead.
     */
    public static withConnection(connection: string | OrmExecutor): OrmConnection;
    public static withConnection<X extends OrmModel>(connection: string | OrmExecutor, model: X): ModelBuilder<X>;
    public static withConnection<X extends OrmModel>(connection: string | OrmExecutor, model?: X): OrmConnection | ModelBuilder<X> {
        const executor = typeof connection === 'string' ? Orm.getExecutor(connection) : connection;
        if (!model) return rawSurfaceOn(executor);

        return new Orm(model).withClient(executor) as ModelBuilder<X>;
    }

    /**
     * Inserts one row: `beforeInsert`/`afterInsert` around the engine's own INSERT, then the row is read back
     * through the engine. Returns it mutable. Whatever `beforeInsert` changed in the payload is what gets written —
     * unless it did the work itself (`{ done: row }`), in which case nothing is inserted and its row comes back.
     * `afterInsert` runs either way.
     */
    public static async create<X extends OrmModel>(model: X, data: OrmCreateData<X>, options?: { client?: OrmQueryable }) {
        const hookCtx: OrmHookContext = { client: options?.client, now: () => Orm.now(), isFirstCall: true, isLastCall: true };
        const intent = await runBeforeInsert(model, data as Obj, hookCtx);

        const builder = new Orm(model);
        if (options?.client) builder.withClient(options.client);

        // The hook did the insert: nothing is written, and the row it hands back is what the caller gets.
        if (intent) {
            if (!intent.skipAfterHook) await runAfterInsert(model, intent.done, hookCtx);
            return createMutableRow(builder, builder.primaryKey as ColsOf<X>, intent.done as OrmBuilderRow<Orm<X>>);
        }

        const pkValue = await builder.insert(data);
        const row = await builder.findOrFailMutable(pkValue);
        await runAfterInsert(model, row, hookCtx);
        return row;
    }

    /**
     * Updates ONE row by its primary key: reads the row first (so `beforeUpdate` sees `ctx.original` and only
     * dirty columns are written), then writes. Returns the row as it now is.
     *
     * The return type is written out because this method hands the class itself (`BuilderCtor`) down, which makes an
     * inferred return type circular.
     */
    public static async update<X extends OrmModel>(
        model: X,
        pkValue: number | string,
        data: OrmUpdateData<X>,
        options?: { client?: OrmQueryable }
    ): Promise<Mutable<OrmBuilderRow<Orm<X>>>> {
        const builder = new Orm(model);
        // The read happens in the transaction too, so the row cannot be updated from a stale copy.
        if (options?.client) builder.withClient(options.client);

        const initialRow = await builder.where(builder.primaryKey, pkValue).firstOrFailMutable();
        return compareAndUpdateOrmRow(model, initialRow, data, undefined, Orm, options?.client);
    }
}
