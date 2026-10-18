/**
 * The configuration an app installs once, at boot: where statements run, the clock that stamps `updated_at`, and who
 * a save attributes `updated_by` to. It lives in one place — this module's variable — rather than on a class the app
 * extends, so every builder reads the same one whatever flavour it is: a main query, a preload callback, a count
 * subquery.
 */
import type { OrmExecutor } from './executor.ts';
import { OrmExecutorMissingError } from './executor.ts';
import type { OrmContext } from './orm_context.ts';

/** What a migrate command needs: the connection knex opens, where the files live, and how to seed afterwards. */
export type OrmMigrationsConfig = {
    /** Passed to knex untouched — `{ host, port, user, password, database }`. */
    connection: unknown;
    /** Absolute; `orm:migrate` defaults it to `database/migrations` under the app root. */
    directory?: string;
    /** Run by `orm:migrate --seed`, after the migrations. */
    seed?(): Promise<void>;
    /**
     * Run after the app's migrations and before the seed. For an app whose schema is owned elsewhere — a
     * folder that migrates itself — this is where that runs, so one `orm:migrate` builds the whole schema.
     */
    after?(): Promise<void>;
};

/** What `Orm.configure()` takes; anything left out keeps its default. */
export type OrmConfig = {
    getExecutor(connectionName?: string): OrmExecutor;
    now(): number;
    getAuthUser(ctx: OrmContext): { id: number } | undefined | null;
    migrations?: OrmMigrationsConfig;
    logExecutionPaths?: boolean;
};

let current: OrmConfig = {
    getExecutor() {
        throw new OrmExecutorMissingError();
    },
    /** `dt.unix()`-shaped seconds — an app overrides it with its own clock. */
    now() {
        return Math.floor(Date.now() / 1000);
    },
    getAuthUser() {
        return undefined;
    },
    logExecutionPaths: false,
};

/** The configuration in force. The statics on `Orm` read it; an app sets it through `Orm.configure()`. */
export function ormConfig(): OrmConfig {
    return current;
}

/** Installs `config`, merged over the configuration in force. Returns what it replaced, so a caller can put it back. */
export function configureOrm(config: Partial<OrmConfig>): OrmConfig {
    const previous = current;

    current = { ...current, ...config };

    return previous;
}
