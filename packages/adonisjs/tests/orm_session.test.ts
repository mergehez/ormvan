/**
 * The session store the engine ships, on the engine's own connection.
 *
 * The statements are recorded through the executor seam — the SQL and the binding order are what has to be right.
 * The rest runs against MySQL: a write is readable by this store and by Adonis' session middleware, an expired row
 * is deleted on read, tagging, and the sweep.
 */
import type { SessionStoreFactory } from '@adonisjs/session/types';
import { test } from '@japa/runner';
import { OrmSessionStore, encodeSessionData, ormSessionStore } from '../src/orm_session.js';
import { Orm } from './support/executor.js';
import { stubRawQuery } from './support/fakes.js';

/** One recorded statement. */
interface Statement {
    sql: string;
    bindings: unknown[];
}

/** The table the MySQL group builds for itself — the specs' shared schema has no session table. */
const TABLE = 'orm_session_spec';

/** A moment in the past, for a row that expired before the test started. */
const past = () => new Date(Date.now() - 60_000);

/**
 * Runs `fn` with a store whose statements are recorded instead of executed, and hands back what it recorded.
 * Garbage collection is off unless a test asks for it.
 */
async function record(fn: (store: OrmSessionStore) => Promise<void>, options: { gcProbability?: number } = {}): Promise<Statement[]> {
    const statements: Statement[] = [];
    const restore = stubRawQuery((sql, bindings) => {
        statements.push({ sql, bindings });
        return [];
    });

    try {
        await fn(new OrmSessionStore({ queryable: () => Orm.getExecutor(), age: '2 hours', gcProbability: options.gcProbability ?? 0 }));
    } finally {
        restore();
    }

    return statements;
}

/** The store the MySQL group uses: the real executor, on its own table, with no sweeps in the way. */
const liveStore = (options: { gcProbability?: number } = {}) =>
    new OrmSessionStore({ queryable: () => Orm.getExecutor(), age: '2 hours', table: TABLE, gcProbability: options.gcProbability ?? 0 });

/** How many rows of the table for this id are still live, judged by MySQL rather than by this process. */
async function liveRows(id: string): Promise<number> {
    const [row] = await Orm.runQuery<{ alive: number }>(`SELECT COUNT(*) AS alive FROM \`${TABLE}\` WHERE \`id\` = ? AND \`expires_at\` > NOW()`, [id]);

    return Number(row?.alive ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. the statements
// ─────────────────────────────────────────────────────────────────────────────

test.group('session store — the statements', () => {
    test('read selects the payload by primary key, limited to one row', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.read('sess-1');
        });

        assert.deepEqual(statements, [{ sql: 'SELECT `data`, `expires_at` FROM `sessions` WHERE `id` = ? LIMIT 1', bindings: ['sess-1'] }]);
    });

    test('write upserts in one statement, repeating the payload and the expiry in both halves', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.write('sess-1', { userId: 5 });
        });
        const [statement] = statements;

        assert.equal(statement.sql, 'INSERT INTO `sessions` (`id`, `data`, `expires_at`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `data` = ?, `expires_at` = ?');
        assert.lengthOf(statement.bindings, 5);
        assert.equal(statement.bindings[0], 'sess-1');
        // The merge half carries the same values as the values half — that is the whole point of the repetition.
        assert.equal(statement.bindings[3], statement.bindings[1]);
        assert.equal(statement.bindings[4], statement.bindings[2]);
        assert.instanceOf(statement.bindings[2], Date);
        assert.include(String(statement.bindings[1]), 'sess-1');
    });

    test('destroy deletes the row, and nothing else', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.destroy('sess-1');
        });

        assert.deepEqual(statements, [{ sql: 'DELETE FROM `sessions` WHERE `id` = ?', bindings: ['sess-1'] }]);
    });

    test('touch moves the expiry without rewriting the payload', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.touch('sess-1');
        });

        assert.equal(statements[0].sql, 'UPDATE `sessions` SET `expires_at` = ? WHERE `id` = ?');
        assert.instanceOf(statements[0].bindings[0], Date);
        assert.equal(statements[0].bindings[1], 'sess-1');
    });

    test('tag inserts a row and merges only the tag, since the payload is not its business', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.tag('sess-1', 7);
        });
        const [statement] = statements;

        assert.equal(statement.sql, 'INSERT INTO `sessions` (`id`, `user_id`, `data`, `expires_at`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `user_id` = ?');
        assert.lengthOf(statement.bindings, 5);
        // The column is a varchar: a numeric id is stored the way the app writes it elsewhere (`String(userId)`).
        assert.equal(statement.bindings[1], '7');
        assert.equal(statement.bindings[4], '7');
        assert.equal(statement.bindings[0], 'sess-1');
    });

    test('untag clears the column — the session id is the whole association', async ({ assert }) => {
        const statements = await record(async (store) => {
            // The contract hands the user id along; the store does not need it to clear the tag.
            await store.untag('sess-1');
        });

        assert.deepEqual(statements, [{ sql: 'UPDATE `sessions` SET `user_id` = ? WHERE `id` = ?', bindings: [null, 'sess-1'] }]);
    });

    test('tagged answers the unexpired rows of one user, by column comparison', async ({ assert }) => {
        const statements = await record(async (store) => {
            await store.tagged(7);
        });

        assert.equal(statements[0].sql, 'SELECT `id`, `data` FROM `sessions` WHERE `user_id` = ? AND `expires_at` > ?');
        assert.equal(statements[0].bindings[0], '7');
        assert.instanceOf(statements[0].bindings[1], Date);
    });

    test('a write sweeps expired rows when the config asks for it, and only then', async ({ assert }) => {
        const swept = await record(
            async (store) => {
                await store.write('sess-1', { userId: 5 });
            },
            { gcProbability: 100 }
        );
        const unswept = await record(async (store) => {
            await store.write('sess-1', { userId: 5 });
        });

        assert.lengthOf(swept, 2);
        assert.equal(swept[1].sql, 'DELETE FROM `sessions` WHERE `expires_at` <= ?');
        assert.instanceOf(swept[1].bindings[0], Date);
        assert.lengthOf(unswept, 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. the behaviour on MySQL
// ─────────────────────────────────────────────────────────────────────────────

test.group('session store — on MySQL', (group) => {
    group.setup(async () => {
        await Orm.runExec(`DROP TABLE IF EXISTS \`${TABLE}\``);
        await Orm.runExec(
            `CREATE TABLE \`${TABLE}\` (
                \`id\` varchar(255) NOT NULL,
                \`data\` text NOT NULL,
                \`user_id\` varchar(255) DEFAULT NULL,
                \`expires_at\` timestamp NOT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`user_id_index\` (\`user_id\`),
                KEY \`expires_at_index\` (\`expires_at\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        );
    });

    group.teardown(async () => {
        await Orm.runExec(`DROP TABLE IF EXISTS \`${TABLE}\``);
    });

    group.each.setup(async () => {
        await Orm.runExec(`DELETE FROM \`${TABLE}\``);
    });

    test('what a write stored is what a read answers', async ({ assert }) => {
        const store = liveStore();
        const data = { userId: 5, name: 'sess', nested: { cart: [1, 2] } };

        await store.write('sess-1', data);

        assert.deepEqual(await store.read('sess-1'), data);
    });

    test('a write to the same session keeps one row and the latest payload', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { step: 1 });
        await store.write('sess-1', { step: 2 });

        const rows = await Orm.runQuery<{ id: string }>(`SELECT \`id\` FROM \`${TABLE}\``);

        assert.lengthOf(rows, 1);
        assert.deepEqual(await store.read('sess-1'), { step: 2 });
    });

    test('a session nobody wrote reads as null', async ({ assert }) => {
        assert.isNull(await liveStore().read('nobody'));
    });

    test('a row past its expiry reads as null and is deleted while it is asked for', async ({ assert }) => {
        const store = liveStore();

        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`expires_at\`) VALUES (?, ?, ?)`, ['sess-old', encodeSessionData({ userId: 1 }, 'sess-old'), past()]);

        assert.isNull(await store.read('sess-old'));
        assert.lengthOf(await Orm.runQuery(`SELECT \`id\` FROM \`${TABLE}\` WHERE \`id\` = ?`, ['sess-old']), 0);
    });

    test('a payload that is not a message this encoder wrote reads as null, not as a throw', async ({ assert }) => {
        const store = liveStore();

        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`expires_at\`) VALUES (?, ?, ?)`, ['sess-bad', 'not-a-message', new Date(Date.now() + 60_000)]);
        // A message built for a different session id fails verification the same way.
        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`expires_at\`) VALUES (?, ?, ?)`, [
            'sess-wrong',
            encodeSessionData({ userId: 1 }, 'someone-else'),
            new Date(Date.now() + 60_000),
        ]);

        assert.isNull(await store.read('sess-bad'));
        assert.isNull(await store.read('sess-wrong'));
    });

    test('touch makes an expired session live again, without touching its payload', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { userId: 5 });
        await Orm.runExec(`UPDATE \`${TABLE}\` SET \`expires_at\` = ? WHERE \`id\` = ?`, [past(), 'sess-1']);

        assert.equal(await liveRows('sess-1'), 0);

        await store.touch('sess-1');

        assert.equal(await liveRows('sess-1'), 1);
        assert.deepEqual(await store.read('sess-1'), { userId: 5 });
    });

    test('tag associates a session with a user, and tagged answers it back', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { userId: 7 });
        await store.tag('sess-1', 7);

        const sessions = await store.tagged(7);

        assert.lengthOf(sessions, 1);
        assert.equal(sessions[0].id, 'sess-1');
        assert.deepEqual(sessions[0].data, { userId: 7 });
    });

    test('tagging an existing session leaves its payload alone', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { keep: 'me' });
        await store.tag('sess-1', 9);

        assert.deepEqual(await store.read('sess-1'), { keep: 'me' });
    });

    test('tagging a session that does not exist yet creates it — the request writes into it afterwards', async ({ assert }) => {
        const store = liveStore();

        await store.tag('sess-new', 9);

        assert.lengthOf(await store.tagged(9), 1);
        assert.deepEqual(await store.read('sess-new'), {});
    });

    test('untag dissociates the session, and tagged stops answering it', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { userId: 7 });
        await store.tag('sess-1', 7);
        await store.untag('sess-1');

        assert.lengthOf(await store.tagged(7), 0);
        // The session itself is untouched — only the tag went away.
        assert.deepEqual(await store.read('sess-1'), { userId: 7 });
    });

    test('tagged skips a session that has expired', async ({ assert }) => {
        const store = liveStore();

        await store.write('sess-1', { userId: 7 });
        await store.tag('sess-1', 7);
        await Orm.runExec(`UPDATE \`${TABLE}\` SET \`expires_at\` = ? WHERE \`id\` = ?`, [past(), 'sess-1']);

        assert.lengthOf(await store.tagged(7), 0);
    });

    test('tagged skips a row whose payload does not verify instead of answering half a session', async ({ assert }) => {
        const store = liveStore();

        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`user_id\`, \`expires_at\`) VALUES (?, ?, ?, ?)`, [
            'sess-bad',
            'not-a-message',
            '7',
            new Date(Date.now() + 60_000),
        ]);

        assert.lengthOf(await store.tagged(7), 0);
    });

    test('the sweep removes expired rows when the config asks for it', async ({ assert }) => {
        const store = liveStore({ gcProbability: 100 });

        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`expires_at\`) VALUES (?, ?, ?)`, ['sess-old', encodeSessionData({}, 'sess-old'), past()]);
        await store.write('sess-1', { userId: 5 });

        const rows = await Orm.runQuery<{ id: string }>(`SELECT \`id\` FROM \`${TABLE}\``);

        assert.deepEqual(
            rows.map((row) => row.id),
            ['sess-1']
        );
    });

    test('with the sweep off, expired rows stay until somebody reads them', async ({ assert }) => {
        const store = liveStore();

        await Orm.runExec(`INSERT INTO \`${TABLE}\` (\`id\`, \`data\`, \`expires_at\`) VALUES (?, ?, ?)`, ['sess-old', encodeSessionData({}, 'sess-old'), past()]);
        await store.write('sess-1', { userId: 5 });

        assert.lengthOf(await Orm.runQuery(`SELECT \`id\` FROM \`${TABLE}\``), 2);
    });

    test('a second store on the same table reads what the first one wrote', async ({ assert }) => {
        await liveStore().write('sess-1', { userId: 5 });

        assert.deepEqual(await liveStore().read('sess-1'), { userId: 5 });
        // The row's expiry is a real one: a store that wrote a datetime into a timestamp column would not read back at all.
        assert.equal(await liveRows('sess-1'), 1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. the shape Adonis asks for
// ─────────────────────────────────────────────────────────────────────────────

test.group('session store — the factory', () => {
    test('ormSessionStore answers a SessionStoreFactory, which is what a session config holds', async ({ assert, expectTypeOf }) => {
        const factory = ormSessionStore({ queryable: () => Orm.getExecutor(), table: TABLE });

        // The type is the claim `stores: { database: … }` relies on: a ctx and the session config in, a store out.
        expectTypeOf(factory).toEqualTypeOf<SessionStoreFactory>();
        assert.isFunction(factory);
    });
});
