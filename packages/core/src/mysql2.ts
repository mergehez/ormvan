/**
 * The mysql2 adapter — the driver seam with no framework service in between.
 *
 * An app builds a pool and returns `mysql2Executor(pool)` from its `Orm` class's `getExecutor()`.
 */
import mysql, { type Pool, type PoolConnection, type PoolOptions } from 'mysql2/promise';
import type { OrmExecutor, OrmQueryable } from './executor.ts';

/** The mysql2 vocabulary this adapter speaks, re-exported so a host wires it up from one module. */
export type { Pool, PoolConnection, PoolOptions };

/** What the adapter needs of a client — a pool and a pooled connection both answer `query`. */
export interface MySql2Client {
    query(sql: string, bindings?: unknown[]): Promise<[unknown, unknown]>;
}

/** A pool for a connection config (mysql2's own options: `host`, `port`, `user`, `database`, …). */
export function mysql2Pool(config: PoolOptions): Pool {
    return mysql.createPool(config);
}

/**
 * Named connections, one pool each, created on first use:
 * `mysql2Connections({ mysql: { … }, 'mysql-lyrics': { … } }, 'mysql')`. A name nobody declared throws; `end()`
 * closes the pools that were opened.
 */
export function mysql2Connections<Configs extends Record<string, PoolOptions>>(
    configs: Configs,
    defaultName: keyof Configs & string,
    app?: { terminating: (callback: () => Promise<void>) => any }
) {
    const pools = new Map<string, Pool>();

    function poolFor(connectionName?: string): Pool {
        const name = connectionName ?? defaultName;
        const config = configs[name];

        if (!config) {
            throw new Error(`Unknown connection '${name}'. Known: ${Object.keys(configs).join(', ')}.`);
        }

        let pool = pools.get(name);

        if (!pool) {
            pool = mysql2Pool(config);
            pools.set(name, pool);
        }

        return pool;
    }

    async function endAllPools(): Promise<void> {
        const open = [...pools.values()];

        pools.clear();
        await Promise.all(open.map((pool) => pool.end()));
    }

    app?.terminating?.(() => endAllPools());

    return {
        /** The executor for a connection: the named one, or the default when no name is given. */
        executor: (connectionName?: string): OrmExecutor => mysql2Executor(poolFor(connectionName)),
        /** Closes every pool opened so far, so nothing is left holding the event loop open. */
        end: endAllPools,
    };
}

/**
 * Wraps a mysql2 client as an engine queryable, so it can be handed to a chain (`builder.withClient(tx)`).
 */
export function mysql2Queryable(client: MySql2Client): OrmQueryable {
    return {
        async query(sql, bindings) {
            refuseUndefined(sql, bindings);

            const [rows] = await client.query(sql, [...bindings]);

            return (rows ?? []) as Record<string, unknown>[];
        },
        /** The raw `[rows, fields]` pair — the shape `resultHeader()` reads `affectedRows`/`insertId` from. */
        async exec(sql, bindings) {
            refuseUndefined(sql, bindings);

            return client.query(sql, [...bindings]);
        },
    };
}

/**
 * Refuses an `undefined` binding: mysql2's text protocol would otherwise escape it as `NULL`, so a payload
 * missing a column would silently write NULL. `null` is how a column is set to NULL.
 */
function refuseUndefined(sql: string, bindings: readonly unknown[]): void {
    const index = bindings.findIndex((binding) => binding === undefined);

    if (index !== -1) {
        throw new Error(`Binding #${index + 1} is undefined — pass \`null\` for a NULL column. In: ${sql}`);
    }
}

/** What a statement gets when its transaction is over — see `transaction()` below. */
const FINISHED_TRANSACTION = 'This transaction is already finished: the query would run outside it, on a connection the pool has taken back.';

/** An engine executor over a mysql2 pool: reads, writes and the one transactional primitive the engine needs. */
export function mysql2Executor(pool: Pool): OrmExecutor {
    const onPool = mysql2Queryable(pool);

    return {
        query: (sql, bindings) => onPool.query(sql, bindings),
        exec: (sql, bindings) => onPool.exec(sql, bindings),
        async transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            const connection: PoolConnection = await pool.getConnection();
            const onConnection = mysql2Queryable(connection);
            let finished = false;

            /**
             * A committed or rolled-back transaction refuses more statements, instead of running them on a
             * connection that is back in the pool.
             */
            const tx: OrmQueryable = {
                query(sql, bindings) {
                    if (finished) throw new Error(FINISHED_TRANSACTION);

                    return onConnection.query(sql, bindings);
                },
                exec(sql, bindings) {
                    if (finished) throw new Error(FINISHED_TRANSACTION);

                    return onConnection.exec(sql, bindings);
                },
            };

            try {
                await connection.beginTransaction();
                const result = await fn(tx);
                await connection.commit();
                finished = true;

                return result;
            } catch (error) {
                finished = true;
                await connection.rollback();
                throw error;
            } finally {
                connection.release();
            }
        },
    };
}
