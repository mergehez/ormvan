/**
 * The engine's specs run through the same seam an app uses: the global configuration (`Orm.configure`), with an
 * executor that can be swapped per test. The specs import `Orm` (see the export at the bottom).
 */
import { Orm, OrmExecutorMissingError, type OrmExecutor, type OrmQueryable } from '../../src/index.js';
import { mysql2Executor, mysql2Pool, type Pool } from '../../src/mysql2.js';
import { dbConfig } from './env.js';

let current: OrmExecutor | undefined;

/** Connection names the specs' configuration has been asked for — see `Orm.withConnection('name')`. */
export const requestedConnections: string[] = [];

Orm.configure({
    getExecutor(connectionName?: string): OrmExecutor {
        // The specs' app has one connection: a name is recorded (so a spec can assert what
        // `Orm.withConnection('name')` forwards) and answered with the same executor.
        if (connectionName) requestedConnections.push(connectionName);
        if (!current) throw new OrmExecutorMissingError();

        return current;
    },
});

/**
 * The specs' `Orm`: the engine's own class, whose generic constructor is what makes `new Orm(User)` infer a builder
 * typed to `User`'s columns.
 */
export { Orm };

/**
 * Installs `executor` as the one every statement in the specs' models runs through; `undefined` restores the
 * "no executor" state, which is what a spec checks throws.
 */
export function useExecutor(executor: OrmExecutor | undefined): void {
    current = executor;
}

/**
 * Installs the mysql2-backed executor once, in the Japa setup hook. One pool on the specs' scratch database.
 */
export function installMySql2Executor(): void {
    pool ??= mysql2Pool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
    });

    useExecutor(mysql2Executor(pool));
}

/** The specs' pool — held so the runner can end it (see `closeMySql2Executor`). */
let pool: Pool | undefined;

/**
 * Ends the specs' pool. Nothing else closes it: mysql2's open handle is enough to keep the test process
 * alive after the last assertion, so the runner's teardown hook has to say so explicitly.
 */
export async function closeMySql2Executor(): Promise<void> {
    const open = pool;

    pool = undefined;
    await open?.end();
}

/** The executor the specs' class is currently answering with — what a stub has to put back. */
export function currentExecutor(): OrmExecutor | undefined {
    return current;
}

/** The specs' `Orm.transaction(...)`: the same static, on the class that carries the executor. */
export function transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
    return Orm.transaction(fn);
}

/** The specs' raw escape hatch — `Orm.runQuery`/`Orm.runFirst` on the class above. */
export const ormRaw = {
    /** Runs `sql` through the installed executor and returns every row. */
    get<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings: readonly unknown[] = []): Promise<Row[]> {
        return Orm.runQuery<Row>(sql, bindings);
    },

    /** Runs `sql` through the installed executor and returns the first row, or `null`. */
    first<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings: readonly unknown[] = []): Promise<Row | null> {
        return Orm.runFirst<Row>(sql, bindings);
    },
};
