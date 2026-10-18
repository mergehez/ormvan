/**
 * `Orm.upsert()` — the single-statement `INSERT ... ON DUPLICATE KEY UPDATE` that `Cache.set()` uses. One statement,
 * so two workers racing on the same key cannot lose an update, and the primary key stays out of the update list.
 */
import { test } from '@japa/runner';
import { column, PlainBaseModel } from '../src/index.js';
import { stubRawQuery } from './support/fakes.js';

const { Orm: OrmBuilder } = await import('./support/executor.js');

/** Like the real `cache` table: keyed by `key`, and with no `id` column at all. */
class FakeCache extends PlainBaseModel {
    static table = 'cache';
    static primaryKey = 'key';
    @column() declare key: string;
    @column() declare value: string;
    @column() declare expiration: number;
}

test.group('orm upsert', (group) => {
    let statements: { sql: string; bindings: any[] }[] = [];
    let restore = () => {};

    group.each.setup(() => {
        statements = [];
        restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            return [[{ affectedRows: 1 }], []];
        });
    });
    group.each.teardown(() => restore());

    test('one statement, with the primary key kept out of the update list', async ({ assert }) => {
        await new OrmBuilder(FakeCache).upsert({ key: 'the-key', value: '"1"', expiration: 100 });

        assert.lengthOf(statements, 1, `expected one statement, got:\n${statements.map((s) => s.sql).join('\n')}`);
        assert.match(statements[0].sql, /^INSERT INTO `cache` \(`key`, `value`, `expiration`\) VALUES \(\?, \?, \?\)/);
        assert.match(statements[0].sql, /ON DUPLICATE KEY UPDATE `value` = \?, `expiration` = \?$/);
        // The update values are bound again rather than `VALUES(col)`, which MySQL 8.0.20
        // deprecates and MariaDB spells differently.
        assert.deepEqual(statements[0].bindings, ['the-key', '"1"', 100, '"1"', 100]);
    });

    test('a payload holding only the primary key is a plain insert', async ({ assert }) => {
        await new OrmBuilder(FakeCache).upsert({ key: 'only-the-key' });

        assert.lengthOf(statements, 1);
        assert.notInclude(statements[0].sql, 'ON DUPLICATE KEY UPDATE');
        assert.deepEqual(statements[0].bindings, ['only-the-key']);
    });

    test('props that are not model columns never reach the SQL', async ({ assert }) => {
        // `computed` is deliberately not a column: a payload must not put its key name in an INSERT.
        // @ts-expect-error not a column of the model
        await new OrmBuilder(FakeCache).upsert({ key: 'k', value: '"v"', expiration: 1, computed: 'not a column' });

        assert.lengthOf(statements, 1);
        assert.notInclude(statements[0].sql, 'computed');
        assert.notInclude(statements[0].bindings.join(','), 'not a column');
    });

    test('an empty payload is refused instead of writing a broken statement', async ({ assert }) => {
        await assert.rejects(() => new OrmBuilder(FakeCache).upsert({}), /got no columns/);
    });
});

/**
 * `upsertBy(toCheck, toUpdate)` — find the row the check columns name, update it, or insert one built from both.
 * Two statements, and the matching hook family runs.
 */
test.group('orm upsertBy', (group) => {
    let statements: { sql: string; bindings: any[] }[] = [];
    /** What the lookup SELECT finds; the re-read after an INSERT returns `insertedInstead`. */
    let found: Record<string, unknown>[] = [];
    let selectCount = 0;
    let restore = () => {};

    group.each.setup(() => {
        statements = [];
        found = [];
        selectCount = 0;
        restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            if (sql.startsWith('SELECT')) {
                selectCount++;
                // The first SELECT is the caller's check; a later one is `ormCreate` reading back.
                return [selectCount === 1 ? found : [{ key: 'k1', value: '"v1"', expiration: 5 }], []];
            }
            if (sql.startsWith('INSERT')) return [{ affectedRows: 1, insertId: 7 }, []];
            return [{ affectedRows: 1 }, []];
        });
    });
    group.each.teardown(() => restore());

    test('with no matching row it inserts, merging the check columns into the payload', async ({ assert }) => {
        found = []; // the SELECT finds nothing

        await new OrmBuilder(FakeCache).upsertBy({ key: 'k1' }, { value: '"v1"', expiration: 5 });

        const insert = statements.find((s) => s.sql.startsWith('INSERT'));
        assert.isDefined(insert, `expected an INSERT, got:\n${statements.map((s) => s.sql).join('\n')}`);
        assert.match(insert!.sql, /^INSERT INTO `cache` \(`key`, `value`, `expiration`\)/);
        assert.deepEqual(insert!.bindings, ['k1', '"v1"', 5], 'the check column is part of the insert');
        assert.notInclude(insert!.sql, 'ON DUPLICATE KEY UPDATE', 'upsertBy is not the single-statement upsert');
    });

    test('with a matching row it updates only what changed, by primary key', async ({ assert }) => {
        // The SELECT returns the row as it exists now.
        found = [{ key: 'k1', value: '"old"', expiration: 1 }];

        await new OrmBuilder(FakeCache).upsertBy({ key: 'k1' }, { value: '"new"' });

        const update = statements.find((s) => s.sql.startsWith('UPDATE'));
        assert.isDefined(update, `expected an UPDATE, got:\n${statements.map((s) => s.sql).join('\n')}`);
        assert.include(update!.sql, 'SET `value` = ?');
        assert.notInclude(update!.sql, 'expiration', 'a column the payload did not mention is left alone');
        assert.include(update!.sql, 'WHERE `key` = ?');
        assert.deepEqual(update!.bindings, ['"new"', 'k1']);
        assert.isUndefined(
            statements.find((s) => s.sql.startsWith('INSERT')),
            'nothing is inserted on the update path'
        );
    });

    test('it refuses a check that names no column instead of writing unconditionally', async ({ assert }) => {
        await assert.rejects(() => new OrmBuilder(FakeCache).upsertBy({}, { value: '"v"' }), /at least one column to match on/);

        // Only the matching columns count: a prop that is not a column leaves nothing to look up by.
        await assert.rejects(() => new OrmBuilder(FakeCache).upsertBy({ nope: 1 }, { value: '"v"' }), /at least one column to match on/);
        assert.deepEqual(statements, [], 'nothing reached the database');
    });
});
