/**
 * The engine's I/O seam: every query runs through the executor of the class it was called on. An app names its
 * executor by overriding `static getExecutor()` on its own `Orm` subclass.
 */
export interface OrmQueryable {
    /** Runs a SELECT-ish statement and returns its rows. */
    query(sql: string, bindings: readonly unknown[]): Promise<Record<string, unknown>[]>;
    /** Runs a write statement and returns the driver's raw result (`affectedRows`, `insertId`, …). */
    exec(sql: string, bindings: readonly unknown[]): Promise<unknown>;
}

/**
 * The executor an app installs: it runs statements and owns the engine's only transactional primitive. A chain
 * joins a transaction by being given it (`builder.withClient(tx)`).
 */
export interface OrmExecutor extends OrmQueryable {
    transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T>;
}

/**
 * Thrown when something asks a class that never provided an executor. There is no global default: an app
 * names its executor once, on its `Orm` subclass, exactly like `now()`/`getAuthUser()`.
 */
export class OrmExecutorMissingError extends Error {
    readonly code = 'E_ORM_EXECUTOR_MISSING';

    constructor() {
        super(
            "No ORM executor. Override `static getExecutor()` on the app's `Orm` subclass (app/orm/project_orm.ts) — for MySQL, `connections.executor(name)` from `mysql2Connections(...)` in `@mergehez/ormvan/mysql2`."
        );
        this.name = 'OrmExecutorMissingError';
    }
}
