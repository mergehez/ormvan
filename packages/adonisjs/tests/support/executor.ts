/**
 * The adapter's specs run through the same seam an app uses: the core engine's global configuration
 * (`Orm.configure`), with an executor that can be swapped per test. The specs import `Orm` (see the export at the
 * bottom).
 */
import { Orm, OrmExecutorMissingError, type OrmExecutor } from '@mergehez/ormvan';
import { mysql2Executor, mysql2Pool, type Pool } from '@mergehez/ormvan/mysql2';

let current: OrmExecutor | undefined;

Orm.configure({
    getExecutor(): OrmExecutor {
        if (!current) throw new OrmExecutorMissingError();

        return current;
    },
});

/**
 * The core engine's own class, whose generic constructor is what makes `new Orm(User)` infer a builder typed to
 * `User`'s columns.
 */
export { Orm };

/** Installs `executor` as the one every statement in the specs runs through; `undefined` restores the empty state. */
export function useExecutor(executor: OrmExecutor | undefined): void {
    current = executor;
}

/** The specs' pool — held so the runner can end it (see `closeMySql2Executor`). */
let pool: Pool | undefined;

/** Installs the mysql2-backed executor once, in the Japa setup hook. One pool on the specs' scratch database. */
export function installMySql2Executor(): void {
    pool ??= mysql2Pool({
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USERNAME ?? 'root',
        password: process.env.DB_PASSWORD ?? '',
        database: process.env.DB_DATABASE ?? 'orm_test',
    });

    useExecutor(mysql2Executor(pool));
}

/**
 * Ends the specs' pool. Nothing else closes it: mysql2's open handle is enough to keep the test process alive after
 * the last assertion, so the runner's teardown hook has to say so explicitly.
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
