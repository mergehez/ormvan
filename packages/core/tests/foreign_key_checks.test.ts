/**
 * `Orm.transaction(fn, { disableForeignKeyChecks: true })`: the toggle rides the connection that runs the writes,
 * and never outlives the transaction.
 */
import { test } from '@japa/runner';
import type { OrmExecutor, OrmQueryable } from '../src/index.js';
import { Orm, installMySql2Executor, useExecutor } from './support/executor.js';

/** An executor that records every statement it runs, and the transactions it was asked to open. */
function recorder(): { executor: OrmExecutor; seen: string[]; opened: () => number } {
    const seen: string[] = [];
    let transactions = 0;
    const executor: OrmExecutor = {
        async query(sql) {
            seen.push(sql);

            return [];
        },
        async exec(sql) {
            seen.push(sql);

            return { affectedRows: 1 };
        },
        async transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            transactions++;
            return fn({
                query: (sql, bindings) => executor.query(sql, bindings),
                exec: (sql, bindings) => executor.exec(sql, bindings),
            });
        },
    };

    return { executor, seen, opened: () => transactions };
}

/** Runs `fn` with a recording executor installed, restoring the suite's executor afterwards. */
async function withRecording(fn: (tools: { executor: OrmExecutor; seen: string[]; opened: () => number }) => Promise<unknown>): Promise<{ seen: string[]; opened: () => number }> {
    const { executor, seen, opened } = recorder();
    useExecutor(executor);
    try {
        await fn({ executor, seen, opened });
    } finally {
        installMySql2Executor();
    }

    return { seen, opened };
}

test.group('Orm.transaction with disableForeignKeyChecks', () => {
    test('turns the checks off and back on around the work, inside one transaction', async ({ assert }) => {
        const { seen, opened } = await withRecording(async () =>
            Orm.transaction(
                async (tx) => {
                    await tx.exec('delete from action_tokens where created_by = ?', [7]);
                    await tx.query('select 1', []);
                },
                { disableForeignKeyChecks: true }
            )
        );

        assert.deepEqual(seen, ['SET SESSION FOREIGN_KEY_CHECKS=0', 'delete from action_tokens where created_by = ?', 'select 1', 'SET SESSION FOREIGN_KEY_CHECKS=1']);
        assert.equal(opened(), 1);
    });

    test('restores the checks when the callback throws, and lets the error through', async ({ assert }) => {
        const { seen } = await withRecording(async () =>
            assert.rejects(
                () =>
                    Orm.transaction(
                        async () => {
                            throw new Error('boom');
                        },
                        { disableForeignKeyChecks: true }
                    ),
                /boom/
            )
        );

        assert.deepEqual(seen, ['SET SESSION FOREIGN_KEY_CHECKS=0', 'SET SESSION FOREIGN_KEY_CHECKS=1']);
    });

    test('leaves the checks alone when the option is not set', async ({ assert }) => {
        const { seen } = await withRecording(async () =>
            Orm.transaction(async (tx) => {
                await tx.exec('delete from action_tokens where created_by = ?', [7]);
            })
        );

        assert.deepEqual(seen, ['delete from action_tokens where created_by = ?']);
    });
});
