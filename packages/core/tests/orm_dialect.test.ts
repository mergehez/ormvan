import { test } from '@japa/runner';

/**
 * `src/orm_sql.ts` is the only place MySQL's own syntax lives. These specs pin its bytes: the engine's compiled SQL
 * must stay identical.
 */
const { insertSql, updateSql, onDuplicateKeyUpdate, deleteSql, explainSql, jsonObject, jsonArrayAggregate, limitOffset, resultHeader, replaceIntoSql } =
    await import('../src/orm_sql.js');
const { softDeleteStatement, restoreStatement, activeRowSql, trashedRowSql } = await import('../src/orm_soft_delete.js');

test.group('orm dialect (MySQL fragments)', () => {
    test('identifiers are backticked, and statements carry one placeholder per value', ({ assert }) => {
        assert.equal(insertSql('games', ['id', 'title'], false), 'INSERT INTO `games` (`id`, `title`) VALUES (?, ?)');
        assert.equal(updateSql('games', ['title'], 'id'), 'UPDATE `games` SET `title` = ? WHERE `id` = ?');
        assert.equal(deleteSql('games'), 'DELETE FROM `games`');
    });

    test('an upsert is INSERT + ON DUPLICATE KEY UPDATE', ({ assert }) => {
        assert.equal(onDuplicateKeyUpdate(['title', 'seen_at']), ' ON DUPLICATE KEY UPDATE `title` = ?, `seen_at` = ?');
        assert.equal(
            insertSql('cache', ['key', 'value'], false) + onDuplicateKeyUpdate(['value']),
            'INSERT INTO `cache` (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?'
        );
    });

    test('the INSERT keyword is the only difference `useIgnore` makes', ({ assert }) => {
        assert.equal(insertSql('users', ['name'], true), 'INSERT IGNORE INTO `users` (`name`) VALUES (?)');
        assert.equal(replaceIntoSql('cache', ['key', 'value']), 'REPLACE INTO `cache` (`key`, `value`) VALUES (?, ?)');
    });

    test('a soft delete binds the app clock, not MySQL’s NOW()', ({ assert }) => {
        // `NOW()` was the old statement's value: a datetime, which MySQL coerced silently into the int
        // columns these schemas use (`20260915175937`, not a timestamp).
        const statement = softDeleteStatement({ column: 'deleted_at', by: 'deleted_by' }, 'games', 7, 1789487961);

        assert.equal(statement.sql, 'UPDATE `games` SET `deleted_at` = ?, `deleted_by` = ?');
        assert.deepEqual(statement.bindings, [1789487961, 7]);
    });

    test('the soft-delete statement follows the config: names, stamp, and no `by`', ({ assert }) => {
        const custom = softDeleteStatement({ column: 'removed_at', by: 'removed_by', stamp: () => 'now' }, 'things', null, 1789487961);
        assert.equal(custom.sql, 'UPDATE `things` SET `removed_at` = ?, `removed_by` = ?');
        assert.deepEqual(custom.bindings, ['now', null]);

        // No `by`: a single-column soft delete — nothing about `deleted_by` is assumed.
        const single = softDeleteStatement({ column: 'deleted_at' }, 'gamesss', null, 42);
        assert.equal(single.sql, 'UPDATE `gamesss` SET `deleted_at` = ?');
        assert.deepEqual(single.bindings, [42]);
    });

    test('restore binds the config’s live value — NULL unless the schema says otherwise', ({ assert }) => {
        const both = restoreStatement({ column: 'deleted_at', by: 'deleted_by' }, 'games', 1789487961);
        assert.equal(both.sql, 'UPDATE `games` SET `deleted_at` = ?, `deleted_by` = ?');
        assert.deepEqual(both.bindings, [null, null]);

        // A schema whose "live" value is a sentinel says so, and it is bound like any other value.
        const sentinel = restoreStatement({ column: 'deleted_at', live: () => 0 }, 'games', 0);
        assert.equal(sentinel.sql, 'UPDATE `games` SET `deleted_at` = ?');
        assert.deepEqual(sentinel.bindings, [0]);
    });

    test('the stamp is bound, so a `datetime`/uuid column needs no special case', ({ assert }) => {
        const date = softDeleteStatement({ column: 'deleted_at', by: 'deleted_by', stamp: (now) => new Date(now * 1000) }, 'games', 'user-uuid', 1789487961);

        assert.equal(date.sql, 'UPDATE `games` SET `deleted_at` = ?, `deleted_by` = ?');
        assert.instanceOf(date.bindings[0], Date);
        assert.equal(date.bindings[1], 'user-uuid');
    });

    test('the live/trashed predicates come from the config', ({ assert }) => {
        assert.equal(activeRowSql({ column: 'deleted_at' }, 'games'), 'games.deleted_at IS NULL');
        assert.equal(trashedRowSql({ column: 'deleted_at' }, 'games'), 'games.deleted_at IS NOT NULL');

        // A schema whose "live" test is not `IS NULL` says so, and the engine never learns why.
        const sentinel = { column: 'deleted_at', activeSql: (ref: string) => `${ref}.deleted_at = 0` };
        assert.equal(activeRowSql(sentinel, 'entries'), 'entries.deleted_at = 0');
    });

    test('EXPLAIN wraps the compiled query', ({ assert }) => {
        assert.equal(explainSql('SELECT * FROM `games`'), 'EXPLAIN SELECT * FROM `games`');
    });

    test('a to-many preload aggregates its JSON rows, and an empty relation reads []', ({ assert }) => {
        assert.equal(jsonObject([`'id', caps.id`, `'title', caps.title`]), `JSON_OBJECT('id', caps.id, 'title', caps.title)`);
        assert.equal(jsonArrayAggregate(`JSON_OBJECT('id', caps.id)`), `COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id', caps.id)), JSON_ARRAY())`);
    });

    test("the tail is MySQL's LIMIT/OFFSET, and omits what was not asked for", ({ assert }) => {
        assert.equal(limitOffset(20, 40), ' LIMIT 20 OFFSET 40');
        assert.equal(limitOffset(20), ' LIMIT 20');
        assert.equal(limitOffset(undefined, 40), ' OFFSET 40');
        assert.equal(limitOffset(), '');
    });

    test("a write result is read from mysql2's [ResultSetHeader, fields]", ({ assert }) => {
        assert.deepEqual(resultHeader([{ affectedRows: 1, insertId: 12 }, []]), { affectedRows: 1, insertId: 12 });
        // No result at all (a driver that reports nothing) is not an error: both fields read undefined.
        assert.deepEqual(resultHeader(undefined), {});
        assert.equal(resultHeader([{}, []])?.affectedRows, undefined);
    });
});
