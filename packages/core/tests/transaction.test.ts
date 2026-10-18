/**
 * Transactions — the engine's only multi-statement primitive:
 *
 * ```ts
 * await Orm.transaction(async (tx) => {
 *     await Game.orm(tx).where('id', id).updateAll({ status: 'active' });
 * });
 * ```
 *
 * A nested `transaction()` is a NEW connection, not a savepoint.
 */
import { test } from '@japa/runner';
import { OrmExecutorMissingError, type OrmHooks, type OrmQueryable } from '../src/index.js';
import { installMySql2Executor, Orm, transaction, useExecutor } from './support/executor.js';
import { rawRows } from './support/fakes.js';
import { ChatMessage, User } from './support/models.js';

/** The required columns of the example `users` table — every raw write below states them. */
const userPayload = (username: string, name = 'Tx') => ({
    username,
    name,
    email: `${username}@test.local`,
    password: '',
    created_at: 0,
    created_by: 0,
    updated_at: 0,
});

/** Removes a row whatever a failed test left behind (soft deletes included). */
async function purgeUser(username: string): Promise<void> {
    await User.orm().withTrashed().where('username', username).delete(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. the seam
// ─────────────────────────────────────────────────────────────────────────────

test.group('transactions — the seam', (group) => {
    group.setup(() => {
        if (!User.booted) User.boot();
    });
    group.each.teardown(() => installMySql2Executor());

    test('with no executor installed, the failure says what to install', async ({ assert }) => {
        useExecutor(undefined);

        await assert.rejects(async () => transaction(async () => 'never'), OrmExecutorMissingError);
    });

    test('the callback’s value is the transaction’s value', async ({ assert }) => {
        useExecutor({
            async query() {
                return [];
            },
            async exec() {
                return { affectedRows: 1 };
            },
            async transaction(fn) {
                return fn({ query: async () => [], exec: async () => ({ affectedRows: 1 }) });
            },
        });

        const value = await transaction(async (tx) => ({ tx, answer: 42 }));

        assert.equal(value.answer, 42);
        assert.isDefined(value.tx);
    });

    test('the executor is resolved per call, never captured', async ({ assert }) => {
        const used: string[] = [];
        const stub = (label: string): OrmQueryable => ({
            async query() {
                used.push(label);
                return [];
            },
            async exec() {
                used.push(label);
                return { affectedRows: 0 };
            },
        });

        useExecutor({
            ...stub('first'),
            async transaction(fn) {
                return fn(stub('first'));
            },
        });
        await transaction(async (tx) => tx.query('SELECT 1', []));

        // Swap the executor: a transaction opened afterwards must use the NEW one — the engine reads the
        // installed executor at call time, which is what lets a host install it while booting.
        useExecutor({
            ...stub('second'),
            async transaction(fn) {
                return fn(stub('second'));
            },
        });
        await transaction(async (tx) => tx.query('SELECT 1', []));

        assert.deepEqual(used, ['first', 'second']);
    });

    test('the exact error thrown inside is the error the caller gets', async ({ assert }) => {
        const boom = new Error('identity');
        let caught: unknown;

        try {
            await transaction(async () => {
                throw boom;
            });
        } catch (error) {
            caught = error;
        }

        assert.strictEqual(caught, boom, 'the engine must not wrap or replace it');
    });

    test('a non-Error throw is propagated as it is', async ({ assert }) => {
        let caught: unknown;

        try {
            await transaction(async () => {
                throw 'a string';
            });
        } catch (error) {
            caught = error;
        }

        assert.strictEqual(caught, 'a string');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. statement routing
// ─────────────────────────────────────────────────────────────────────────────

test.group('transactions — statement routing', (group) => {
    /** Records the first line of every statement it is asked to run — reads and writes alike. */
    function recorder(label: string, log: string[]): OrmQueryable {
        return {
            async query(sql) {
                log.push(label + sql.split('\n')[0]);
                return sql.includes('FROM users') ? [{ id: 1, username: 'x' }] : [{ total: 0 }];
            },
            async exec(sql) {
                log.push(label + sql.split('\n')[0]);
                return { affectedRows: 1, insertId: 1 };
            },
        };
    }

    /**
     * The leading SQL verb of every recorded statement, in order — enough to pin a path's shape without pinning
     * bytes.
     */
    const verbs = (log: string[]) => log.map((entry) => entry.replace(/^(inside|outside):/, '').split(' ')[0]);

    /** Runs `fn` with a recorder installed, and returns what ran inside vs. outside the transaction. */
    async function record(fn: (tx: OrmQueryable) => Promise<unknown>) {
        const outside: string[] = [];
        const inside: string[] = [];

        useExecutor({
            ...recorder('outside:', outside),
            async transaction(callback) {
                return callback(recorder('inside:', inside));
            },
        });

        await transaction(fn);
        return { inside, outside };
    }

    group.each.teardown(() => installMySql2Executor());

    test('every read on a client-carrying chain runs inside the transaction', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            const users = User.orm().withClient(tx);
            await users.get();
            await User.orm().withClient(tx).where('id', 1).first();
            await User.orm().withClient(tx).count();
            await User.orm().withClient(tx).countDistinct('id', 'distinct_ids');
            await User.orm().withClient(tx).exists();
        });

        assert.deepEqual(verbs(inside), ['SELECT', 'SELECT', 'SELECT', 'SELECT', 'SELECT'], 'get/first/count/countDistinct/exists, one statement each');
        assert.deepEqual(outside, [], `no read may escape the transaction, got ${JSON.stringify(outside)}`);
    });

    test('every write primitive runs inside the transaction', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            await User.orm().withClient(tx).insert(userPayload('tx-write'));
            await User.orm().withClient(tx).update(1, { name: 'Tx' });
            await User.orm().withClient(tx).where('id', 1).updateAll({ name: 'Tx' });
            await User.orm().withClient(tx).upsert(userPayload('tx-upsert'));
            await User.orm().withClient(tx).where('id', 1).delete(null);
            await User.orm().withClient(tx).deleteBy(2, 1);
        });

        // `User` is soft-deletable, so both deletes are UPDATEs (the scope + `deleted_at` stamp); the upsert
        // is one INSERT … ON DUPLICATE KEY UPDATE. Nothing here needs a SELECT — and all six are on the tx.
        assert.deepEqual(verbs(inside), ['INSERT', 'UPDATE', 'UPDATE', 'INSERT', 'UPDATE', 'UPDATE']);
        assert.deepEqual(outside, [], `a write escaped the transaction: ${JSON.stringify(outside)}`);
    });

    test('the sub-builders a chain spawns inherit the client', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            // An eager preload runs its own SELECT, a paginating one runs late (after the main query),
            // and `withCount`/`whereHas` compile extra (sub)queries — all of them must be on the tx.
            await User.orm().withClient(tx).preload('messages').where('id', 1).first();
            await User.orm()
                .withClient(tx)
                .preloadCb('messages', (q) => q.paginating(5))
                .where('id', 1)
                .first();
            await User.orm().withClient(tx).withCount('messages').where('id', 1).first();
            await User.orm().withClient(tx).whereHas('messages').where('id', 1).first();
        });

        assert.isAbove(inside.length, 4, `expected the spawned builders to run inside too, got ${JSON.stringify(inside)}`);
        assert.deepEqual(outside, [], `a spawned builder escaped the transaction: ${JSON.stringify(outside)}`);
    });

    test('joining is explicit: a chain without the client uses the connection', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            // The contrast that documents the contract: `withClient(tx)` is what puts a chain on the
            // transaction. Nothing about being inside the callback changes where a query runs.
            await User.orm().where('id', 1).first();
            await User.orm().withClient(tx).where('id', 1).first();
        });

        assert.lengthOf(outside, 1, `the plain chain must run outside, got ${JSON.stringify(outside)}`);
        assert.lengthOf(inside, 1, `the client-carrying chain must run inside, got ${JSON.stringify(inside)}`);
    });

    test('Orm.create/Orm.update route their write AND their read-back inside', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            const created = await Orm.create(User, userPayload('tx-create'), { client: tx });
            await Orm.update(User, created.id, { name: 'Updated' }, { client: tx });
        });

        // Five statements, and the shape matters: `Orm.create` inserts then re-reads the row it wrote,
        // `Orm.update` reads the row, writes it, then re-reads it again. Every one of those reads has to see
        // the transaction's own uncommitted state — a read-back on the connection would return stale data.
        assert.deepEqual(verbs(inside), ['INSERT', 'SELECT', 'SELECT', 'UPDATE', 'SELECT']);
        assert.deepEqual(outside, [], `a read-back escaped the transaction: ${JSON.stringify(outside)}`);
    });

    test('a mutable row remembers the client for save() and refresh()', async ({ assert }) => {
        const { inside, outside } = await record(async (tx) => {
            const row = await User.orm().withClient(tx).where('id', 1).firstOrFailMutable();
            row.name = 'Renamed';
            await row.save();
            await row.refresh();
        });

        // SELECT (the read) + UPDATE + SELECT (save returns the row as it now is) + SELECT (refresh).
        assert.deepEqual(verbs(inside), ['SELECT', 'UPDATE', 'SELECT', 'SELECT']);
        assert.deepEqual(outside, [], `the row escaped the transaction: ${JSON.stringify(outside)}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. commit & rollback
// ─────────────────────────────────────────────────────────────────────────────

test.group('transactions — commit & rollback', (group) => {
    group.each.teardown(async () => {
        await purgeUser('tx-commit');
        await purgeUser('tx-rollback');
        await purgeUser('tx-multi');
        await purgeUser('tx-outside');
    });

    test('a committed transaction keeps its writes', async ({ assert }) => {
        await purgeUser('tx-commit');

        const created = await transaction(async (tx) => {
            return await Orm.create(User, userPayload('tx-commit'), { client: tx });
        });

        // The return value survives the commit and is usable afterwards.
        assert.isAbove(created.id, 0);
        assert.isNotNull(await User.orm().where('username', 'tx-commit').first());
    });

    test('a thrown error rolls the whole transaction back', async ({ assert }) => {
        await purgeUser('tx-rollback');
        const boom = new Error('boom');

        await assert.rejects(
            () =>
                transaction(async (tx) => {
                    await User.orm().withClient(tx).insert(userPayload('tx-rollback'));
                    // Read-your-own-writes: inside the transaction the row is there...
                    assert.isNotNull(await User.orm().withClient(tx).where('username', 'tx-rollback').first());

                    throw boom;
                }),
            /boom/
        );

        // ...and after the rollback it never existed.
        assert.isNull(await User.orm().where('username', 'tx-rollback').first());
    });

    test('inside the transaction a soft delete hides the row, and withTrashed still finds it', async ({ assert }) => {
        await assert.rejects(() =>
            transaction(async (tx) => {
                await User.orm().withClient(tx).where('id', 3).delete(1);

                // The engine's soft-delete scope is part of the query, transaction or not.
                assert.isNull(await User.orm().withClient(tx).where('id', 3).first());
                assert.isNotNull(await User.orm().withClient(tx).withTrashed().where('id', 3).first());

                throw new Error('rollback the soft delete');
            })
        );

        // Rolled back: the row is live again, scope included.
        assert.isNotNull(await User.orm().where('id', 3).first());
    });

    test('a rollback reverts every kind of write together', async ({ assert }) => {
        const snapshot = async () => (await User.orm().withTrashed().orderBy('id').get()).map((row) => `${row.id}:${row.name}:${row.deleted_at ?? '-'}:${row.username}`);
        const before = await snapshot();

        await assert.rejects(() =>
            transaction(async (tx) => {
                await User.orm().withClient(tx).where('id', 1).updateAll({ name: 'tx-multi-updated' });
                await User.orm().withClient(tx).where('id', 2).delete(1);
                await User.orm().withClient(tx).insert(userPayload('tx-multi'));
                await User.orm()
                    .withClient(tx)
                    .upsert({ ...userPayload('tx-multi'), name: 'upserted' });

                throw new Error('roll everything back');
            })
        );

        assert.deepEqual(await snapshot(), before, 'the tables must be exactly as they were');
    });

    test('a rollback leaves writes made outside the transaction alone', async ({ assert }) => {
        await purgeUser('tx-outside');

        // Committed outside the failing transaction — it has to survive it.
        await User.orm().insert(userPayload('tx-outside', 'Outside'));

        await assert.rejects(() =>
            transaction(async (tx) => {
                await User.orm().withClient(tx).where('username', 'tx-outside').updateAll({ name: 'Inside' });
                throw new Error('only the transaction rolls back');
            })
        );

        const row = await User.orm().where('username', 'tx-outside').first();
        assert.equal(row?.name, 'Outside', 'an autocommit write is not part of the transaction');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. isolation & nesting
// ─────────────────────────────────────────────────────────────────────────────

test.group('transactions — isolation & nesting', (group) => {
    group.each.teardown(async () => {
        await purgeUser('tx-isolated');
        await purgeUser('tx-outer');
        await purgeUser('tx-inner');
    });

    test('a second transaction does not see uncommitted writes', async ({ assert }) => {
        await purgeUser('tx-isolated');

        await transaction(async (txA) => {
            await User.orm().withClient(txA).insert(userPayload('tx-isolated', 'Uncommitted'));

            await transaction(async (txB) => {
                assert.notStrictEqual(txB, txA, 'each transaction gets its own queryable');
                // MySQL's REPEATABLE READ: txB has its own snapshot, so the row is invisible to it.
                assert.isNull(await User.orm().withClient(txB).where('username', 'tx-isolated').first());
            });
        });

        // Once txA committed, the row is there for everyone.
        assert.isNotNull(await User.orm().where('username', 'tx-isolated').first());
    });

    test('a nested transaction() is a separate transaction, not a savepoint', async ({ assert }) => {
        await purgeUser('tx-outer');
        await purgeUser('tx-inner');

        await assert.rejects(() =>
            transaction(async (txOuter) => {
                await User.orm().withClient(txOuter).insert(userPayload('tx-outer'));

                // A nested `transaction()` is a NEW connection, not a savepoint: the inner write is committed on
                // its own, so the outer rollback cannot undo it — and it would BLOCK on a row the outer wrote.
                await transaction(async (txInner) => {
                    await User.orm().withClient(txInner).insert(userPayload('tx-inner', 'Committed'));
                });

                throw new Error('outer rolls back');
            })
        );

        assert.isNull(await User.orm().where('username', 'tx-outer').first(), 'the outer write rolled back');
        assert.isNotNull(await User.orm().where('username', 'tx-inner').first(), 'the inner transaction committed on its own');
    });

    test('a rollback leaves no state behind for the next transaction', async ({ assert }) => {
        await purgeUser('tx-isolated');

        await assert.rejects(() =>
            transaction(async (tx) => {
                await User.orm().withClient(tx).insert(userPayload('tx-isolated'));
                throw new Error('first transaction fails');
            })
        );

        // A second transaction on a fresh connection must not inherit the rolled-back row (nor the
        // connection's snapshot) — the pool hands out a clean client.
        const seen = await transaction(async (tx) => User.orm().withClient(tx).where('username', 'tx-isolated').first());

        assert.isNull(seen);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. rules inside a transaction
// ─────────────────────────────────────────────────────────────────────────────

/** `afterInsert` writes through the transaction the caller passed — the hook/transaction contract. */
class CascadingUser extends User {
    static table = 'users';
    static seenClients: unknown[] = [];

    static hooks: OrmHooks<typeof CascadingUser> = {
        afterInsert: async (row, ctx) => {
            CascadingUser.seenClients.push(ctx.client);
            await ChatMessage.orm().withClient(ctx.client!).insert({ content: 'written by the hook', receiver_id: row.id, read_at: null, created_at: 0, created_by: row.id });
        },
    };
}

/** A model whose `beforeInsert` always throws — the veto point of a write. */
class GuardedUser extends User {
    static table = 'users';
    static hooks: OrmHooks<typeof GuardedUser> = {
        beforeInsert: () => {
            throw new Error('hook-veto');
        },
    };
}

test.group('transactions — rules inside a transaction', (group) => {
    group.setup(() => {
        for (const model of [CascadingUser, GuardedUser]) {
            if (!model.booted) model.boot();
        }
    });

    group.each.teardown(async () => {
        await purgeUser('tx-guard');
        await purgeUser('tx-hook');
        await purgeUser('tx-guarded-insert');
        await rawRows('DELETE FROM chat_messages WHERE content = ?', ['written by the hook']);
    });

    test('the bulk-delete/bulk-update guard still holds, and nothing is written', async ({ assert }) => {
        const before = (await User.orm().where('id', 1).first())?.name;

        await assert.rejects(() =>
            transaction(async (tx) => {
                await User.orm().withClient(tx).updateAll({ name: 'no-where' });
            })
        );

        assert.equal((await User.orm().where('id', 1).first())?.name, before);
    });

    test('a write hook gets the transaction and its write is part of it', async ({ assert }) => {
        CascadingUser.seenClients = [];
        await purgeUser('tx-hook');

        let seenInside: OrmQueryable | undefined;

        await assert.rejects(() =>
            transaction(async (tx) => {
                seenInside = tx;
                await Orm.create(CascadingUser, userPayload('tx-hook'), { client: tx });

                // The hook's insert ran on the transaction, so it is visible inside it…
                assert.isNotNull(await ChatMessage.orm().withClient(tx).where('content', 'written by the hook').first());

                throw new Error('roll the hook’s write back too');
            })
        );

        assert.strictEqual(CascadingUser.seenClients[0], seenInside, 'the hook is handed the caller’s transaction');
        // …and the rollback took it with the row: had the hook written on the connection, it would survive.
        assert.isNull(await ChatMessage.orm().where('content', 'written by the hook').first());
        assert.isNull(await User.orm().where('username', 'tx-hook').first());
    });

    test('a hook that throws rolls the transaction back and surfaces its error', async ({ assert }) => {
        await purgeUser('tx-guarded-insert');

        await assert.rejects(() => transaction((tx) => Orm.create(GuardedUser, userPayload('tx-guarded-insert'), { client: tx })), /hook-veto/);

        assert.isNull(await User.orm().where('username', 'tx-guarded-insert').first());
    });

    test('outside a transaction a hook sees no client', async ({ assert }) => {
        CascadingUser.seenClients = [];
        await purgeUser('tx-guard');

        await Orm.create(CascadingUser, userPayload('tx-guard'), {});

        assert.isUndefined(CascadingUser.seenClients[0], 'no transaction, no client');
    });

    test('a row read inside a closed transaction cannot write any more', async ({ assert }) => {
        await purgeUser('tx-guard');
        const created = await Orm.create(User, userPayload('tx-guard', 'Original'), {});
        const row = await transaction((tx) => User.orm().withClient(tx).where('id', created.id).firstOrFailMutable());

        row.name = 'Changed after the transaction';

        // The row kept the transaction it was read in, and MySQL/knex refuses queries on a finished one
        // ("Transaction query already complete…"). That is the safe outcome: it cannot silently write
        // through a released connection — but it is also why a row must not outlive its transaction.
        await assert.rejects(() => row.save());
        assert.equal((await User.orm().where('id', created.id).first())?.name, 'Original');
    });
});
