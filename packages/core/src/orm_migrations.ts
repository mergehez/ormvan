/**
 * Migrations, run by **knex** — it owns the files, the batches and the `knex_migrations` table. This module is the
 * engine's half: finding the files, naming them, and handing knex the connection.
 *
 * A migration is a module exporting `up(knex)` and `down(knex)`; `orm:migrate` (see `commands/orm_migrate.ts`) is the
 * command over this, and an app that wants its own can import `ormMigrator` from `@mergehez/ormvan/orm_migrations`.
 *
 * `knex` is an optional peer and is imported lazily, so an app that never migrates does not install it.
 */
import type { Knex } from 'knex';
import { readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OrmMigrationInvalidError, OrmMigrationsMissingError } from './orm_errors.ts';

/** What `ormMigrator()` needs. The connection is passed to knex untouched (`{ host, port, user, password, database }`). */
export interface OrmMigrationsOptions {
    connection: unknown;
    /** Absolute path to the directory holding the migration files. */
    directory: string;
    /** What `make()` writes; defaults to `ts`. */
    extension?: string;
}

/** The three things a migrate command does. */
export interface OrmMigrator {
    /** What ran and what is waiting, by migration name. */
    status(): Promise<{ applied: string[]; pending: string[] }>;
    /** Everything pending, in one batch. */
    latest(): Promise<{ batch: number; ran: string[] }>;
    /** The last batch, undone by each migration's `down`. */
    rollback(): Promise<{ batch: number; rolled: string[] }>;
    /** Scaffolds a migration, returning the file it wrote. */
    make(name: string): Promise<string>;
    /** Ends the connection knex opened. */
    destroy(): Promise<void>;
}

/** A source file the migrator will load. `name` is the file name without its extension — that is what gets recorded. */
interface OrmMigrationFile {
    name: string;
    path: string;
}

/** What knex hands back in a list: its own source yields paths, a custom one yields whatever it returned. */
type MigrationEntry = string | OrmMigrationFile;

/** Source extensions, in the order that wins when a directory holds more than one file of the same name. */
const SOURCE_EXTENSIONS = ['.ts', '.js', '.mjs'];

/** knex's bookkeeping table, which the rename below reaches into. */
const MIGRATIONS_TABLE = 'knex_migrations';

/**
 * knex's own source records a migration's file name *with* its extension, which makes `0001_x.ts` and `0001_x.js` two
 * different migrations — so a database migrated from source sees the compiled file as pending, and runs it again.
 * This source records the name without the extension: one migration, whichever file it was loaded from.
 */
class OrmMigrationSource implements Knex.MigrationSource<OrmMigrationFile> {
    constructor(private readonly directory: string) {}

    async getMigrations(): Promise<OrmMigrationFile[]> {
        let entries: string[];

        try {
            entries = readdirSync(this.directory);
        } catch {
            throw new OrmMigrationsMissingError(this.directory);
        }

        // Keyed by name, so a build that sits next to its sources still yields one entry per migration.
        const files = new Map<string, string>();

        for (const extension of [...SOURCE_EXTENSIONS].reverse()) {
            for (const entry of entries) {
                if (extname(entry) !== extension) {
                    continue;
                }

                files.set(basename(entry, extension), entry);
            }
        }

        return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => ({ name, path: join(this.directory, file) }));
    }

    getMigrationName(migration: OrmMigrationFile): string {
        return migration.name;
    }

    async getMigration(migration: OrmMigrationFile): Promise<Knex.Migration> {
        const module = (await import(pathToFileURL(migration.path).href)) as { up?: unknown; down?: unknown };

        if (typeof module.up !== 'function' || typeof module.down !== 'function') {
            throw new OrmMigrationInvalidError(migration.name);
        }

        return {
            up: (knex) => (module.up as (knex: Knex) => Promise<void>)(knex),
            down: (knex) => (module.down as (knex: Knex) => Promise<void>)(knex),
        };
    }
}

/**
 * A migrator over `directory`, connected to `connection`.
 *
 * ```ts
 * const migrator = await ormMigrator({ connection, directory: 'database/migrations' });
 * await migrator.latest();
 * await migrator.destroy();
 * ```
 */
export async function ormMigrator(options: OrmMigrationsOptions): Promise<OrmMigrator> {
    const { default: knexFactory } = (await import('knex')) as { default: KnexFactory };
    const knex = knexFactory({ client: 'mysql2', connection: options.connection });
    const source = new OrmMigrationSource(options.directory);
    const config = { migrationSource: source };

    await adoptRecordedNames(knex, source);

    return {
        async status() {
            // With a custom source both lists come back as its own entries, not as names.
            const [applied, pending] = (await knex.migrate.list(config)) as [MigrationEntry[], MigrationEntry[]];
            const name = (migration: MigrationEntry): string => (typeof migration === 'string' ? migration : migration.name);

            return { applied: applied.map(name), pending: pending.map(name) };
        },

        async latest() {
            const [batch, ran] = (await knex.migrate.latest(config)) as [number, string[]];

            return { batch, ran };
        },

        async rollback() {
            const [batch, rolled] = (await knex.migrate.rollback(config)) as [number, string[]];

            return { batch, rolled };
        },

        make(name: string) {
            return knex.migrate.make(name, { directory: options.directory, extension: options.extension ?? 'ts' });
        },

        destroy() {
            return knex.destroy();
        },
    };
}

/** knex has no exportable factory type, and this module is the only place that names one. */
type KnexFactory = (config: { client: string; connection: unknown }) => Knex;

/**
 * A database migrated by an earlier route recorded `0001_x.ts`; this one answers to `0001_x`. Without the rename the
 * names look different, which knex reports as a corrupt directory and which would re-run every migration. Records are
 * only touched where the extension-free name is a migration that exists.
 */
async function adoptRecordedNames(knex: Knex, source: OrmMigrationSource): Promise<void> {
    if (!(await knex.schema.hasTable(MIGRATIONS_TABLE))) {
        return;
    }

    const names = new Set((await source.getMigrations()).map((migration) => migration.name));
    const recorded = (await knex(MIGRATIONS_TABLE).select<{ name: string }[]>('name')).map((row) => row.name);

    for (const name of recorded) {
        const extension = extname(name);
        const stripped = basename(name, extension);

        if (!SOURCE_EXTENSIONS.includes(extension) || !names.has(stripped) || recorded.includes(stripped)) {
            continue;
        }

        await knex(MIGRATIONS_TABLE).where({ name }).update({ name: stripped });
    }
}
