/**
 * Raw write values — `dbRaw('(SELECT COUNT(*) …)')` in an insert/update payload: the expression goes into the
 * statement, and its own bindings take the place the column's `?` would have taken.
 */
import { test } from '@japa/runner';
import { column, dbRaw, jsonDec, type OrmExecutor, type OrmQueryable } from '../src/index.js';
import { installMySql2Executor, useExecutor } from './support/executor.js';
import { MyBaseModel } from './support/models.js';

type Seen = { sql: string; bindings: readonly unknown[] };

/** A model with a plain column, a number, and a `jsonDec` column — enough for the cast and the raw cases. */
class RawTopic extends MyBaseModel {
    static table = 'topics';

    @column() declare title: string;
    @column() declare status: number;
    @column(jsonDec) declare mentions: string[];
}

/** An executor that records every statement it is asked to run. */
function recorder(): { executor: OrmExecutor; seen: Seen[] } {
    const seen: Seen[] = [];
    const executor: OrmExecutor = {
        async query(sql, bindings) {
            seen.push({ sql, bindings });

            return [];
        },
        async exec(sql, bindings) {
            seen.push({ sql, bindings });

            return { affectedRows: 1, insertId: 9 };
        },
        async transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            return fn({ query: (sql, bindings) => executor.query(sql, bindings), exec: (sql, bindings) => executor.exec(sql, bindings) });
        },
    };

    return { executor, seen };
}

/** Runs `fn` with a recording executor installed, restoring the suite's executor afterwards. */
async function recording(fn: () => Promise<unknown>): Promise<Seen[]> {
    const { executor, seen } = recorder();
    useExecutor(executor);
    try {
        await fn();
    } finally {
        installMySql2Executor();
    }

    return seen;
}

test.group('raw write values (dbRaw)', (group) => {
    group.setup(() => {
        if (!RawTopic.booted) RawTopic.boot();
    });

    test('updateAll inlines a dbRaw expression and binds the plain columns in place', async ({ assert }) => {
        const seen = await recording(() =>
            RawTopic.orm()
                .where('id', 5)
                .updateAll({ status: 2, title: dbRaw('upper(`title`)') })
        );

        assert.lengthOf(seen, 1);
        assert.match(seen[0].sql, /^UPDATE `topics` SET /);
        assert.include(seen[0].sql, '`title` = (upper(`title`))');
        assert.include(seen[0].sql, '`status` = ?');
        assert.deepEqual(seen[0].bindings, [2, 5]);
    });

    test('a dbRaw expression brings its own bindings, in column order', async ({ assert }) => {
        const seen = await recording(() =>
            RawTopic.orm()
                .where('id', 5)
                .updateAll({
                    status: dbRaw('(select count(*) from entries y where y.created_by = ?)', [7]),
                    title: 'x',
                })
        );

        // Bindings follow the statement: the expression's binding sits where its `?` would have, and the
        // columns are written in the model's declaration order (`title`, `status`) — not the payload's.
        assert.deepEqual(seen[0].bindings, ['x', 7, 5]);
        assert.include(seen[0].sql, '`status` = ((select count(*) from entries y where y.created_by = ?))');
    });

    test('insert inlines dbRaw and still applies a column cast to plain values', async ({ assert }) => {
        const raw = await recording(() => RawTopic.orm().insert({ id: 1, title: 'a', mentions: dbRaw('json_array()') }));
        assert.include(raw[0].sql, 'VALUES (?, ?, (json_array()))');
        assert.deepEqual(raw[0].bindings, [1, 'a']);

        // `jsonDec`'s `prepare` runs for a value, and is skipped for the expression.
        const cast = await recording(() => RawTopic.orm().insert({ id: 1, mentions: ['a', 'b'] }));
        assert.deepEqual(cast[0].bindings, [1, '["a","b"]']);
    });

    test('update (one row by primary key) keeps the key binding last', async ({ assert }) => {
        const seen = await recording(() => RawTopic.orm().update(5, { status: dbRaw('`status` + 1'), title: 'y' }));

        assert.include(seen[0].sql, 'WHERE `id` = ?');
        assert.deepEqual(seen[0].bindings, ['y', 5]);
    });

    test('replaceInto writes the expression the same way', async ({ assert }) => {
        const seen = await recording(() => RawTopic.orm().replaceInto({ id: 1, title: dbRaw('upper(?)', ['a']) }));

        assert.include(seen[0].sql, 'VALUES (?, (upper(?)))');
        assert.deepEqual(seen[0].bindings, [1, 'a']);
    });
});
