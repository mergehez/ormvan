/**
 * `Orm.withConnection(executor)`: running somewhere that is not the app's default connection. Nothing is installed,
 * so a spec can hand it a recorder and watch what reaches it.
 */
import { test } from '@japa/runner';
import type { OrmExecutor, OrmQueryable } from '../src/index.js';
import { Orm, installMySql2Executor, requestedConnections, useExecutor } from './support/executor.js';
import { Topic } from './support/models.js';

type Seen = { sql: string; bindings: readonly unknown[] };

/** An executor that records what it is asked to run and answers with `rows`. */
function recorder(rows: Record<string, unknown>[] = [{ id: 7, slug: 'a-b' }]): { executor: OrmExecutor; seen: Seen[] } {
    const seen: Seen[] = [];
    const executor: OrmExecutor = {
        async query(sql, bindings) {
            seen.push({ sql, bindings });

            return rows;
        },
        async exec(sql, bindings) {
            seen.push({ sql, bindings });

            return { affectedRows: 1 };
        },
        async transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            return fn({
                query: (sql, bindings) => executor.query(sql, bindings),
                exec: (sql, bindings) => executor.exec(sql, bindings),
            });
        },
    };

    return { executor, seen };
}

test.group('Orm.withConnection', (group) => {
    group.setup(() => {
        if (!Topic.booted) Topic.boot();
    });

    test('the raw surface runs its statements on the connection it was given', async ({ assert }) => {
        const { executor, seen } = recorder();
        const lyrics = Orm.withConnection(executor);

        const rows = await lyrics.runQuery<{ id: number; slug: string }>('select * from items where slug like ?', ['a%']);

        assert.deepEqual(rows, [{ id: 7, slug: 'a-b' }]);
        assert.deepEqual(seen, [{ sql: 'select * from items where slug like ?', bindings: ['a%'] }]);
    });

    test('runFirst answers the first row, or null when that connection returns none', async ({ assert }) => {
        const { executor } = recorder();

        assert.deepEqual(await Orm.withConnection(executor).runFirst('select 1'), { id: 7, slug: 'a-b' });
        assert.isNull(await Orm.withConnection(recorder([]).executor).runFirst('select 1'));
    });

    test('runExec hands the write to that connection and returns the driver result', async ({ assert }) => {
        const { executor, seen } = recorder();

        const result = await Orm.withConnection(executor).runExec('update items set slug = ?', ['x']);

        assert.deepEqual(result, { affectedRows: 1 });
        assert.deepEqual(seen, [{ sql: 'update items set slug = ?', bindings: ['x'] }]);
    });

    test('a transaction opened there stays there', async ({ assert }) => {
        const { executor, seen } = recorder();

        await Orm.withConnection(executor).transaction(async (tx) => {
            await tx.query('select 1', []);
            await tx.exec('update items set slug = ? where id = ?', ['x', 1]);
        });

        assert.deepEqual(seen, [
            { sql: 'select 1', bindings: [] },
            { sql: 'update items set slug = ? where id = ?', bindings: ['x', 1] },
        ]);
    });

    test('a connection name is resolved by the configured executor', async ({ assert }) => {
        const { executor, seen } = recorder();
        requestedConnections.length = 0;
        useExecutor(executor);
        try {
            await Orm.withConnection('lyrics').runQuery('select 1');
        } finally {
            installMySql2Executor();
        }

        assert.deepEqual(requestedConnections, ['lyrics']);
        assert.deepEqual(seen, [{ sql: 'select 1', bindings: [] }]);
    });

    test('given a model, it returns that model’s builder on the same connection', async ({ assert }) => {
        const { executor, seen } = recorder([{ id: 3, title: 'a topic' }]);

        const topic = await Orm.withConnection(executor, Topic).where('id', 3).first();

        assert.equal(topic?.title, 'a topic');
        assert.lengthOf(seen, 1);
        assert.match(seen[0].sql, /from `?topics`?/i);
        assert.deepEqual(seen[0].bindings, [3]);
    });
});
