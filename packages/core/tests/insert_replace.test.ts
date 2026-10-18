/**
 * `Orm.insert()` — including its `useIgnore` flag — and `Orm.replaceInto()`.
 *
 *  - `insert(data)`       → `INSERT INTO`: a duplicate key is an error.
 *  - `insert(data, true)` → `INSERT IGNORE INTO`: a duplicate key is a warning, the row is skipped.
 *  - `replaceInto(data)`  → `REPLACE INTO`: the conflicting row is DELETED and the payload inserted.
 */
import { test } from '@japa/runner';
import { colAs, column, PlainBaseModel } from '../src/index.js';
import { stubRawQuery } from './support/fakes.js';

const { Orm: OrmBuilder } = await import('./support/executor.js');

/** An auto-increment `id` table: the payload carries no primary key, so `insertId` is the answer. */
class FakeUser extends PlainBaseModel {
    static table = 'users';
    @column() declare id: number;
    @column() declare name: string;
}

/** The target of an insert from a query: one row per user, plus the constants a payload may carry. */
class FakeStats extends PlainBaseModel {
    static table = 'user_statistics';
    @column() declare id: number;
    @column() declare user_id: number;
    @column() declare entries: number;
    @column() declare cepiks: number;
}

/** Like the real `cache` table: keyed by `key`, with no `id` column at all. */
class FakeCache extends PlainBaseModel {
    static table = 'cache';
    static primaryKey = 'key';
    @column() declare key: string;
    @column() declare value: string;
}

test.group('orm insert', (group) => {
    let statements: { sql: string; bindings: any[] }[] = [];
    let restore = () => {};

    group.each.setup(() => {
        statements = [];
        restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            // mysql2's write shape: `[ResultSetHeader, fields]` — the header carries `insertId`.
            return [{ affectedRows: 1, insertId: 7 }, []];
        });
    });
    group.each.teardown(() => restore());

    test('one statement, and the driver insertId comes back when the payload has no key', async ({ assert }) => {
        const id = await new OrmBuilder(FakeUser).insert({ name: 'a' });

        assert.lengthOf(statements, 1);
        assert.equal(statements[0].sql, 'INSERT INTO `users` (`name`) VALUES (?)');
        assert.deepEqual(statements[0].bindings, ['a']);
        assert.equal(id, 7);
    });

    test('`useIgnore: true` compiles `INSERT IGNORE INTO`, leaving the rest of the statement alone', async ({ assert }) => {
        const id = await new OrmBuilder(FakeUser).insert({ name: 'a' }, true);

        assert.lengthOf(statements, 1);
        assert.equal(statements[0].sql, 'INSERT IGNORE INTO `users` (`name`) VALUES (?)');
        assert.deepEqual(statements[0].bindings, ['a'], 'the flag changes the keyword, not the bindings');
        assert.equal(id, 7);
    });

    test('a payload carrying its own primary key returns that key, not the driver insertId', async ({ assert }) => {
        const key = await new OrmBuilder(FakeCache).insert({ key: 'k1', value: '"v1"' });

        assert.equal(statements[0].sql, 'INSERT INTO `cache` (`key`, `value`) VALUES (?, ?)');
        assert.equal(key, 'k1');
    });

    test('only the columns the payload actually names reach the statement', async ({ assert }) => {
        // `value` is left out rather than bound as `undefined` (which mysql2 would reject anyway).
        await new OrmBuilder(FakeCache).insert({ key: 'k1', value: undefined });

        assert.equal(statements[0].sql, 'INSERT INTO `cache` (`key`) VALUES (?)');
        assert.deepEqual(statements[0].bindings, ['k1']);
    });

    test('props that are not model columns never reach the SQL', async ({ assert }) => {
        await new OrmBuilder(FakeUser).insert({ name: 'a', computed: 'not a column' });

        assert.notInclude(statements[0].sql, 'computed');
        assert.notInclude(statements[0].bindings.join(','), 'not a column');
    });

    test('an empty payload is refused instead of writing a broken statement', async ({ assert }) => {
        await assert.rejects(() => new OrmBuilder(FakeUser).insert({}), /got no columns/);
        assert.lengthOf(statements, 0, 'nothing reached the database');
    });
});

test.group('orm replaceInto', (group) => {
    let statements: { sql: string; bindings: any[] }[] = [];
    let restore = () => {};

    group.each.setup(() => {
        statements = [];
        restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            return [{ affectedRows: 1, insertId: 7 }, []];
        });
    });
    group.each.teardown(() => restore());

    test('one REPLACE INTO statement — not an upsert, not a read-modify-write', async ({ assert }) => {
        const key = await new OrmBuilder(FakeCache).replaceInto({ key: 'k1', value: '"v1"' });

        assert.lengthOf(statements, 1);
        assert.equal(statements[0].sql, 'REPLACE INTO `cache` (`key`, `value`) VALUES (?, ?)');
        assert.deepEqual(statements[0].bindings, ['k1', '"v1"']);
        assert.notInclude(statements[0].sql, 'ON DUPLICATE KEY UPDATE', 'a conflict deletes the old row instead');
        assert.equal(key, 'k1');
    });

    test('an id-keyed model takes the driver insertId, like a plain insert', async ({ assert }) => {
        const id = await new OrmBuilder(FakeUser).replaceInto({ name: 'a' });

        assert.equal(statements[0].sql, 'REPLACE INTO `users` (`name`) VALUES (?)');
        assert.equal(id, 7);
    });

    test('only the named columns reach the statement — the rest fall back to the schema defaults', async ({ assert }) => {
        // Unlike `insert`, a REPLACE deletes the row first, so an omitted column is NOT preserved:
        // it gets its DB default. Spelling the column list out is what makes that visible here.
        await new OrmBuilder(FakeCache).replaceInto({ key: 'k1' });

        assert.equal(statements[0].sql, 'REPLACE INTO `cache` (`key`) VALUES (?)');
        assert.deepEqual(statements[0].bindings, ['k1']);
    });

    test('props that are not model columns never reach the SQL', async ({ assert }) => {
        await new OrmBuilder(FakeUser).replaceInto({ name: 'a', computed: 'not a column' });

        assert.notInclude(statements[0].sql, 'computed');
        assert.notInclude(statements[0].bindings.join(','), 'not a column');
    });

    test('an empty payload is refused instead of writing a broken statement', async ({ assert }) => {
        await assert.rejects(() => new OrmBuilder(FakeUser).replaceInto({}), /got no columns/);
        assert.lengthOf(statements, 0, 'nothing reached the database');
    });
});

test.group('orm insert from a query', (group) => {
    let statements: { sql: string; bindings: any[] }[] = [];
    let restore = () => {};

    group.each.setup(() => {
        statements = [];
        restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            // The driver's answer to an INSERT: how many rows it wrote.
            return [{ affectedRows: 3, insertId: 0 }, []];
        });
    });
    group.each.teardown(() => restore());

    test('a builder inserts the rows it selects, with "the missing ones" as a NOT IN subquery', async ({ assert }) => {
        const affected = await new OrmBuilder(FakeStats).insert(
            new OrmBuilder(FakeUser).select(colAs('id', 'user_id')).whereNotIn('id', new OrmBuilder(FakeStats).select('user_id')),
            true
        );

        assert.lengthOf(statements, 1);
        assert.equal(
            statements[0].sql,
            'INSERT IGNORE INTO `user_statistics` (`user_id`) SELECT\n  users.id AS user_id\nFROM users\nWHERE users.id NOT IN (SELECT\n  user_statistics.user_id\nFROM user_statistics)'
        );
        assert.deepEqual(statements[0].bindings, []);
        assert.equal(affected, 3, 'the driver count is what comes back from the row-source form');
    });

    test("the select's own bindings travel into the insert", async ({ assert }) => {
        await new OrmBuilder(FakeStats).insert(new OrmBuilder(FakeUser).select(colAs('id', 'user_id')).where('id', '>', 100));

        assert.equal(statements[0].sql, 'INSERT INTO `user_statistics` (`user_id`) SELECT\n  users.id AS user_id\nFROM users\nWHERE users.id > ?');
        assert.deepEqual(statements[0].bindings, [100]);
    });

    test('a select that names no columns is refused — the target column would be a guess', async ({ assert }) => {
        await assert.rejects(() => new OrmBuilder(FakeStats).insert(new OrmBuilder(FakeUser).select('id'), true), /does not name its columns/);
        assert.lengthOf(statements, 0, 'nothing reached the database');
    });

    test('insertMany writes every row in ONE statement, in tuple order', async ({ assert }) => {
        const count = await new OrmBuilder(FakeStats).insertMany([
            { user_id: 1, entries: 2, cepiks: 0 },
            { user_id: 2, entries: 0, cepiks: 3 },
        ]);

        assert.equal(statements[0].sql, 'INSERT INTO `user_statistics` (`user_id`, `entries`, `cepiks`) VALUES (?, ?, ?), (?, ?, ?)');
        assert.deepEqual(statements[0].bindings, [1, 2, 0, 2, 0, 3]);
        assert.lengthOf(statements, 1, 'one round trip, not one per row');
        // The return value is whatever the driver reported (`affectedRows`), so it is the statement shape that is
        // pinned here — a stub elsewhere in the suite chooses the number.
        assert.isNumber(count);
    });

    test('insertMany refuses a row that is missing a column the first row stated', async ({ assert }) => {
        // The columns are stated once in the statement, so a short row would shift every value after it.
        await assert.rejects(() => new OrmBuilder(FakeStats).insertMany([{ user_id: 1, entries: 1, cepiks: 1 }, { user_id: 2 } as never]), /missing entries, cepiks/);
        assert.lengthOf(statements, 0, 'nothing reached the database');

        assert.equal(await new OrmBuilder(FakeStats).insertMany([]), 0, 'an empty batch writes nothing');
        assert.lengthOf(statements, 0);
    });

    test('FOR UPDATE is the last clause of the statement, after limit/offset', ({ assert }) => {
        const { sql } = new OrmBuilder(FakeUser).where('name', 'queued').orderBy('id', 'asc').limit(10).forUpdate().toSQL();

        // A lock clause must come after LIMIT/OFFSET, or MySQL rejects the statement.
        assert.equal(sql, 'SELECT\n  users.`id`, users.`name`\nFROM users\nWHERE users.name = ? ORDER BY users.id asc LIMIT 10\nFOR UPDATE');
    });
});
