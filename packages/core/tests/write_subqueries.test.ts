/**
 * A builder as a write-payload value — compiled into a `(SELECT COUNT(*) …)` subquery, so a counter column is
 * computed by the database in the statement that writes it:
 *
 * ```ts
 * await UserStatistics.orm().where('id', id).updateAll((q) => ({
 *     entries: Entry.orm().where('created_by', q.ref('user_id')).where('status', 1),
 * }));
 * ```
 *
 * `q.ref(column)` is inlined as a reference to the row being updated, never bound.
 */
import { test } from '@japa/runner';
import { column, dbRaw, sqlAs, type OrmExecutor, type OrmQueryable } from '../src/index.js';
import { installMySql2Executor, useExecutor } from './support/executor.js';
import { MyBaseModel, MyBaseModelSoftDeletable } from './support/models.js';

type Seen = { sql: string; bindings: readonly unknown[] };

/** The row being updated: an id plus two counters the payload fills from subqueries. */
class StatsRow extends MyBaseModel {
    static table = 'user_statistics';

    @column() declare user_id: number;
    @column() declare entries: number;
    @column() declare cepiks: number;
}

/** The counted child — soft-deletable, so the subquery's own scope shows up in the SQL. */
class ChildEntry extends MyBaseModelSoftDeletable {
    static table = 'entries';

    @column() declare status: number;
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

            return { affectedRows: 1, insertId: 3 };
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

test.group('subquery write values', (group) => {
    group.setup(() => {
        if (!StatsRow.booted) StatsRow.boot();
        if (!ChildEntry.booted) ChildEntry.boot();
    });

    test('countSql() makes it a counted subquery, correlated through q.ref', async ({ assert }) => {
        const seen = await recording(() =>
            StatsRow.orm()
                .where('id', 5)
                .updateAll((q) => ({
                    entries: ChildEntry.orm().where('created_by', q.ref('user_id')).where('status', 1).countSql(),
                    cepiks: 2,
                }))
        );

        assert.lengthOf(seen, 1);
        assert.include(seen[0].sql, '`entries` = (SELECT COUNT(*) FROM entries WHERE');
        // The child's own soft-delete scope, then the correlation, inlined rather than bound.
        assert.include(seen[0].sql, 'entries.deleted_at IS NULL');
        assert.include(seen[0].sql, 'entries.created_by = user_statistics.user_id');
        assert.include(seen[0].sql, 'entries.status = ?');
        assert.include(seen[0].sql, '`cepiks` = ?');
        // One flat list: the subquery's binding takes the place its column's `?` would have taken.
        assert.deepEqual(seen[0].bindings, [1, 2, 5]);
    });

    test('a builder is inlined as it compiled — its own select decides the scalar', async ({ assert }) => {
        const seen = await recording(() =>
            StatsRow.orm()
                .where('id', 5)
                .updateAll((q) => ({
                    entries: ChildEntry.orm()
                        .where('created_by', q.ref('user_id'))
                        .select(sqlAs('MAX(`id`)', 'latest', 0)),
                }))
        );

        assert.include(seen[0].sql, '`entries` = (SELECT');
        assert.include(seen[0].sql, 'MAX(`id`) AS latest');
        assert.include(seen[0].sql, 'entries.created_by = user_statistics.user_id');
        assert.deepEqual(seen[0].bindings, [5]);
    });

    test('a builder value with no correlation counts on its own', async ({ assert }) => {
        const seen = await recording(() =>
            StatsRow.orm().update(5, {
                entries: ChildEntry.orm()
                    .where('status', 1)
                    .select(sqlAs('COUNT(*)', 'total', 0)),
            })
        );

        assert.include(seen[0].sql, '`entries` = (SELECT');
        assert.include(seen[0].sql, 'COUNT(*) AS total');
        assert.deepEqual(seen[0].bindings, [1, 5]);
    });

    test('a builder in an insert payload is a scalar the database computes', async ({ assert }) => {
        const seen = await recording(() =>
            StatsRow.orm().insert({
                id: 1,
                entries: ChildEntry.orm()
                    .where('status', 1)
                    .select(sqlAs('COUNT(*)', 'total', 0)),
                cepiks: 4,
            })
        );

        assert.include(seen[0].sql, 'VALUES (?, (SELECT');
        assert.include(seen[0].sql, 'COUNT(*) AS total');
        assert.deepEqual(seen[0].bindings, [1, 1, 4]);
    });

    test('insert carries a scalar the database computes through dbRaw', async ({ assert }) => {
        const seen = await recording(() =>
            StatsRow.orm().insert({
                id: 1,
                entries: dbRaw('SELECT COUNT(*) FROM entries WHERE status = ?', [1]),
                cepiks: 4,
            })
        );

        assert.include(seen[0].sql, 'VALUES (?, (SELECT COUNT(*) FROM entries WHERE status = ?), ?)');
        assert.deepEqual(seen[0].bindings, [1, 1, 4]);
    });

    test("q.ref() only accepts the updated model's own columns", ({ assert }) => {
        // Never called: the point is that the callback below does not compile. A correlate column is a column
        // of the row being updated, so a typo has to be a type error rather than SQL that names nothing.
        const build = () =>
            StatsRow.orm()
                .where('id', 5)
                .updateAll((q) => {
                    // @ts-expect-error `user_idd` is not a column of `StatsRow`
                    const typo = q.ref('user_idd');
                    return { entries: typo };
                });

        assert.isFunction(build);
    });
});
