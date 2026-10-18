/**
 * The migrator: what it finds, what it runs, what it records, and the one thing knex gets wrong here — it records a
 * migration's name *with* the file's extension, so a database migrated from sources would re-run everything once the
 * compiled files exist.
 */
import { test } from '@japa/runner';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrmMigrationInvalidError, OrmMigrationsMissingError } from '../src/index.js';
import { ormMigrator, type OrmMigrator } from '../src/orm_migrations.js';
import { dbConfig } from './support/env.js';
import { installMySql2Executor, Orm } from './support/executor.js';

const TABLE = 'migration_spec_widgets';
const BOOKKEEPING = ['knex_migrations', 'knex_migrations_lock'];

/** The same connection the specs' pool uses; knex opens its own. */
const connection = {
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
};

test.group('migrations', (group) => {
    let directory: string;
    let migrator: OrmMigrator | undefined;

    /** A migration file whose two halves are one statement each. */
    const write = (name: string, up: string, down = `DROP TABLE IF EXISTS \`${TABLE}\``): void => {
        writeFileSync(join(directory, name), `export const up = (knex) => knex.raw(${JSON.stringify(up)});\nexport const down = (knex) => knex.raw(${JSON.stringify(down)});\n`);
    };

    const open = async (dir: string = directory): Promise<OrmMigrator> => (migrator = await ormMigrator({ connection, directory: dir }));

    group.each.setup(async () => {
        installMySql2Executor();
        directory = mkdtempSync(join(tmpdir(), 'orm-migrations-'));

        await Orm.runExec(`DROP TABLE IF EXISTS \`${TABLE}\``, []);
        for (const table of BOOKKEEPING) {
            await Orm.runExec(`DROP TABLE IF EXISTS \`${table}\``, []);
        }
    });

    group.each.teardown(async () => {
        await migrator?.destroy();
        migrator = undefined;
        rmSync(directory, { recursive: true, force: true });
        await Orm.runExec(`DROP TABLE IF EXISTS \`${TABLE}\``, []);

        // Put the real executor back: the specs share the one installed at boot, and a later file would fail with
        // "No ORM executor" if this left the class without one.
        installMySql2Executor();
    });

    test('lists the directory by name, without the extension', async ({ assert }) => {
        write('0001_widgets.mjs', `CREATE TABLE \`${TABLE}\` (\`id\` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (\`id\`))`);
        write('0002_label.mjs', `ALTER TABLE \`${TABLE}\` ADD COLUMN \`label\` varchar(191) NULL`, `ALTER TABLE \`${TABLE}\` DROP COLUMN \`label\``);

        assert.deepEqual(await (await open()).status(), { applied: [], pending: ['0001_widgets', '0002_label'] });
    });

    test('runs what is pending, records it, and runs nothing twice', async ({ assert }) => {
        write('0001_widgets.mjs', `CREATE TABLE \`${TABLE}\` (\`id\` int NOT NULL AUTO_INCREMENT, \`name\` varchar(191) NULL, PRIMARY KEY (\`id\`))`);
        const migrator = await open();

        assert.deepEqual(await migrator.latest(), { batch: 1, ran: ['0001_widgets'] });

        const columns = await Orm.runQuery<{ Field: string }>('SHOW COLUMNS FROM `migration_spec_widgets`', []);
        assert.deepEqual(
            columns.map((column) => column.Field),
            ['id', 'name']
        );

        assert.deepEqual(await migrator.latest(), { batch: 1, ran: [] });
        assert.deepEqual(await migrator.status(), { applied: ['0001_widgets'], pending: [] });
    });

    test('keeps a migration’s name when its file changes extension', async ({ assert }) => {
        // The case this source exists for: `0001_widgets.js` may not look like a new migration to a database that
        // recorded `0001_widgets.mjs`.
        write('0001_widgets.mjs', `CREATE TABLE \`${TABLE}\` (\`id\` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (\`id\`))`);
        const migrator = await open();
        await migrator.latest();

        renameSync(join(directory, '0001_widgets.mjs'), join(directory, '0001_widgets.js'));

        assert.deepEqual(await migrator.status(), { applied: ['0001_widgets'], pending: [] });
        assert.deepEqual(await migrator.latest(), { batch: 1, ran: [] });
    });

    test('adopts a database that recorded the file name with its extension', async ({ assert }) => {
        // The old route recorded `0001_widgets.mjs`; this one answers to `0001_widgets`, and the two have to be one
        // migration — otherwise knex reports a corrupt directory and the file runs a second time.
        write('0001_widgets.mjs', `CREATE TABLE \`${TABLE}\` (\`id\` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (\`id\`))`);

        await Orm.runExec('CREATE TABLE `knex_migrations` (`id` int unsigned NOT NULL AUTO_INCREMENT, `name` varchar(255), `batch` int, PRIMARY KEY (`id`))', []);
        await Orm.runExec('INSERT INTO `knex_migrations` (`name`, `batch`) VALUES (?, ?)', ['0001_widgets.mjs', 1]);

        const migrator = await open();

        assert.deepEqual(await migrator.status(), { applied: ['0001_widgets'], pending: [] });
        assert.deepEqual(await migrator.latest(), { batch: 1, ran: [] });

        const rows = await Orm.runQuery<{ name: string }>('SELECT `name` FROM `knex_migrations`', []);
        assert.deepEqual(
            rows.map((row) => row.name),
            ['0001_widgets']
        );
    });

    test('rolls the last batch back through its `down`', async ({ assert }) => {
        write('0001_widgets.mjs', `CREATE TABLE \`${TABLE}\` (\`id\` int NOT NULL AUTO_INCREMENT, PRIMARY KEY (\`id\`))`);
        const migrator = await open();
        await migrator.latest();

        assert.deepEqual(await migrator.rollback(), { batch: 1, rolled: ['0001_widgets'] });
        assert.lengthOf(await Orm.runQuery('SHOW TABLES LIKE ?', [TABLE]), 0);
        assert.deepEqual(await migrator.status(), { applied: [], pending: ['0001_widgets'] });
    });

    test('scaffolds a migration', async ({ assert }) => {
        const file = await (await open()).make('add_widgets');

        assert.include(file, directory);
        assert.match(file, /[0-9]+_add_widgets\.ts$/);
    });

    test('names a directory that is not there', async ({ assert }) => {
        migrator = await ormMigrator({ connection, directory: join(directory, 'nope') });

        await assert.rejects(() => migrator!.status(), OrmMigrationsMissingError);
    });

    test('names a migration that exports half of the pair', async ({ assert }) => {
        writeFileSync(join(directory, '0001_half.mjs'), 'export const up = () => {};\n');

        await assert.rejects(async () => (await open()).latest(), OrmMigrationInvalidError);
    });
});
