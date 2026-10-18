/**
 * Proves the test app boots: model metadata is read and the builder compiles SQL without touching a database.
 */
import { column } from '../src/index.js';
import { test } from '@japa/runner';
import { Orm, ormRaw } from './support/executor.js';
import { FakeBaseModel, FakeBaseModelSoft, stubRawQuery } from './support/fakes.js';

class FakeUser extends FakeBaseModel {
    static table = 'users';
    @column() declare username: string;
}

class FakeTopic extends FakeBaseModelSoft {
    static table = 'topics';
    @column() declare title: string;
}

test.group('engine smoke test', () => {
    test('the app boots and a builder compiles SQL', ({ assert }) => {
        const { sql, bindings } = new Orm(FakeUser).where('username', 'mergehez').toSQL();

        assert.include(sql, 'users');
        assert.include(sql, 'username');
        assert.deepEqual(bindings, ['mergehez']);
    });

    test('a soft-deletable model gets the deleted_at guard, a plain one does not', ({ assert }) => {
        assert.match(new Orm(FakeTopic).toSQL().sql, /deleted_at is null/i);
        assert.notMatch(new Orm(FakeUser).toSQL().sql, /deleted_at/i);
    });

    test('execution goes through db.rawQuery, which the stubs intercept', async ({ assert }) => {
        const calls: string[] = [];
        const restore = stubRawQuery((sql) => {
            calls.push(sql);
            return [[{ found: 1 }]];
        });

        const exists = await ormRaw.first<{ found: number }>('SELECT EXISTS(SELECT 1) AS found');

        restore();
        assert.equal(exists?.found, 1);
        assert.lengthOf(calls, 1);
    });
});
