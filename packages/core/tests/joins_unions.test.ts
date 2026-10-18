/**
 * Ad-hoc joins (`join(Model, …)`, the raw `…Sql` forms, `joinSub`) and set operations (`union`/`unionAll`): the SQL
 * they compile to, the row type a join adds, the order their bindings land in, and the fact that MySQL accepts a
 * union written as a parenthesized statement around the main query.
 */
import { test } from '@japa/runner';
import { OrmModel } from '../src/index.ts';
import { OrmRow } from '../src/orm_engine.ts';
import { ChatMessage, Topic, User, UserRating } from './support/models.js';

type Join<T extends OrmModel, U extends OrmModel> = OrmRow<T> & OrmRow<U>;

test.group('joins', () => {
    test('join(model) takes the table from the model and adds its columns to the row', ({ assert, expectTypeOf }) => {
        const inner = User.orm().join(UserRating, 'id', '=', 'target_id');

        expectTypeOf(inner._fakeFirst()).toExtend<Join<typeof User, typeof UserRating>>();

        const sql = inner.toSQL().sql;
        assert.include(sql, 'INNER JOIN user_ratings ON users.id = user_ratings.target_id');
        assert.include(sql, 'user_ratings.`value`'); // the joined model's own columns are selected...
        assert.notInclude(sql, 'user_ratings.`id`'); // ...except a name users also has: `users.id` stays the row's id
    });

    test('leftJoin and rightJoin keep the type, and an operand may be a raw fragment', ({ assert, expectTypeOf }) => {
        const left = User.orm().leftJoin(UserRating, { sql: 'users.id' }, '=', { sql: 'user_ratings.target_id' });
        const right = User.orm().rightJoin(UserRating, 'id', '!=', 'target_id');

        expectTypeOf(left._fakeFirst()).toExtend<Join<typeof User, typeof UserRating>>();
        expectTypeOf(right._fakeFirst()).toExtend<Join<typeof User, typeof UserRating>>();
        assert.include(left.toSQL().sql, 'LEFT JOIN user_ratings ON users.id = user_ratings.target_id');
        assert.include(right.toSQL().sql, 'RIGHT JOIN user_ratings ON users.id != user_ratings.target_id');
    });

    test('crossJoin(model) adds the columns and carries no ON', ({ assert, expectTypeOf }) => {
        const q = User.orm().crossJoin(Topic);

        expectTypeOf(q._fakeFirst()).toExtend<Join<typeof User, typeof Topic>>();

        const sql = q.toSQL().sql;
        assert.include(sql, 'CROSS JOIN topics');
        assert.notInclude(sql, 'topics ON');
        assert.include(sql, 'topics.`title`');
    });

    test('two joined models keep both, in call order', ({ assert, expectTypeOf }) => {
        const q = User.orm().join(Topic, 'id', '=', 'created_by').leftJoin(UserRating, 'id', '=', 'target_id');

        expectTypeOf(q._fakeFirst()).toExtend<Join<typeof User, typeof Topic>>();
        expectTypeOf(q._fakeFirst()).toHaveProperty('value');

        const sql = q.toSQL().sql;
        assert.isTrue(sql.indexOf('INNER JOIN topics') < sql.indexOf('LEFT JOIN user_ratings'));
        assert.include(sql, 'topics.`title`');
        assert.include(sql, 'user_ratings.`value`');
    });

    test('a selection still decides this model’s columns, and the joined ones stay', ({ assert }) => {
        const sql = User.orm().select('id', 'username').join(Topic, 'id', '=', 'created_by').toSQL().sql;

        assert.include(sql, 'SELECT\n  users.id, users.username,');
        assert.include(sql, 'topics.`title`');
        assert.notInclude(sql, 'users.`name`'); // the selection is what it says it is
    });

    test('joinSql is the untyped form, for an alias or a table no model describes', ({ assert }) => {
        const sql = User.orm().joinSql('topics as t2', 'users.id', '=', 't2.created_by').toSQL().sql;

        assert.include(sql, 'INNER JOIN topics as t2 ON users.id = t2.created_by');
        assert.notInclude(sql, 't2.`title`'); // no model, so nothing is added to the row
    });

    test('crossJoinSql and leftJoinSub keep the untyped and derived-table forms', ({ assert }) => {
        const sub = User.orm().select('id').where('id', '>', 5);
        const sql = User.orm().crossJoinSql('cache').leftJoinSub(sub, 'older', 'older.id', '=', 'users.id').toSQL().sql;

        assert.include(sql, 'CROSS JOIN cache');
        assert.include(sql, 'LEFT JOIN (SELECT');
        assert.include(sql, ') older ON older.id = users.id');
    });

    test('leftJoinSub joins a derived table as LEFT', ({ assert }) => {
        const sub = User.orm().select('id').where('id', '>', 5);
        const sql = User.orm().leftJoinSub(sub, 'older', 'older.id', '=', 'users.id').toSQL().sql;

        assert.include(sql, 'LEFT JOIN (SELECT');
        assert.include(sql, ') older ON older.id = users.id');
    });

    test('a derived table keeps its own bindings, ahead of the where', ({ assert }) => {
        const sub = User.orm().select('id').where('id', '>', 5);

        const { bindings } = User.orm().joinSub(sub, 'older', 'older.id', '=', 'users.id').where('id', '<', 10).toSQL();

        assert.deepEqual(bindings, [5, 10]);
    });
});

test.group('joins inside a preload callback', () => {
    test('the join compiles into the preload subquery, and its columns into the nested row', ({ assert }) => {
        const sql = Topic.orm()
            .preloadCb('creator', (q) => q.join(UserRating, 'id', '=', 'target_id'))
            .toSQL().sql;

        assert.include(sql, '(SELECT JSON_OBJECT('); // the preload is one scalar subquery
        assert.include(sql, 'INNER JOIN user_ratings ON users.id = user_ratings.target_id');
        assert.include(sql, "'value', user_ratings.value"); // the joined columns are keys in that row...
        assert.notInclude(sql, "'id', user_ratings.id"); // ...except a name the child (a user) already has
    });

    test('a raw table join in a preload adds the clause and no columns', ({ assert }) => {
        const sql = Topic.orm()
            .preloadCb('creator', (q) => q.leftJoinSql('user_ratings as r', 'users.id', '=', 'r.target_id'))
            .toSQL().sql;

        assert.include(sql, 'LEFT JOIN user_ratings as r ON users.id = r.target_id');
        assert.notInclude(sql, 'r.`value`');
    });
});

test.group('unions', () => {
    test('both sides are parenthesized, so each one keeps its own tail', ({ assert }) => {
        const { sql, bindings } = User.orm()
            .select('id')
            .where('id', '>', 5)
            .limit(10)
            .union(User.orm().select('id').where('id', '<', 2).orderBy('id', 'desc'))
            .toSQL();

        assert.match(sql, /^\(SELECT/);
        assert.include(sql, ')\nUNION (SELECT');
        assert.include(sql, 'LIMIT 10'); // the receiver's tail stayed inside its own parentheses
        assert.include(sql, 'ORDER BY users.id desc');
        assert.deepEqual(bindings, [5, 2]); // receiver first, then the member
    });

    test('unionAll is the ALL form, and members stack in call order', ({ assert }) => {
        const sql = User.orm().select('id').union(User.orm().select('id').where('id', 1)).unionAll(User.orm().select('id').where('id', 2)).toSQL().sql;

        assert.include(sql, ')\nUNION (SELECT');
        assert.include(sql, ')\nUNION ALL (SELECT');
        assert.isTrue(sql.indexOf('UNION (') < sql.indexOf('UNION ALL ('));
    });

    test('countSql counts the union as a derived table, not this model’s table', ({ assert }) => {
        const value = User.orm().select('id').where('id', 1).union(User.orm().select('id').where('id', 2)).countSql('total');

        assert.match(value.sql, /^SELECT COUNT\(\*\) AS total FROM \(\(SELECT/);
        assert.deepEqual(value.bindings, [1, 2]);
    });
});

test.group('joins & unions against the database', (group) => {
    const base = { name: 'Union', email: 'union@example.com', created_at: 0, created_by: 0, updated_at: 0 };

    group.setup(async () => {
        if (!User.booted) User.boot();
        for (const username of ['union-a', 'union-b']) {
            await User.orm().withTrashed().where('username', username).delete(null);
            await User.orm().upsert({ ...base, username });
        }
    });

    test('a unioned read returns both sides', async ({ assert }) => {
        const rows = await User.orm().select('id', 'username').where('username', 'union-a').union(User.orm().select('id', 'username').where('username', 'union-b')).get();

        assert.deepEqual(rows.map((row) => row.username).sort(), ['union-a', 'union-b']);
    });

    test('union() removes duplicates, unionAll() keeps them', async ({ assert }) => {
        const side = () => User.orm().select('username').where('username', 'union-a');

        assert.lengthOf(await side().union(side()).get(), 1);
        assert.lengthOf(await side().unionAll(side()).get(), 2);
    });

    test('count() and paginate() count the union, not one of its sides', async ({ assert }) => {
        const q = User.orm().select('id', 'username').where('username', 'union-a').union(User.orm().select('id', 'username').where('username', 'union-b'));

        assert.equal(await q.count(), 2);

        const page = await q.paginate(1, 10);
        assert.equal(page.total, 2);
        assert.lengthOf(page.items, 2);
    });

    test('a preload with a join brings the joined column into the nested row', async ({ assert }) => {
        await ChatMessage.orm().upsert({ content: 'joined', receiver_id: 2, created_at: 0, created_by: 1 });

        const rows = await User.orm()
            .where('username', 'mazlum')
            .preloadCb('messages', (q) => q.join(Topic, 'created_by', '=', 'created_by'))
            .get();

        assert.lengthOf(rows, 1);
        assert.equal(rows[0].messages[0]?.content, 'joined');
        assert.equal(rows[0].messages[0]?.title, 'first topic'); // user 1 owns topic 1, so the join finds it
    });

    test('the joined model’s columns come back, and inner/left differ as they should', async ({ assert }) => {
        // Seeded: users 1 and 2 own topics 1 and 2, user 3 owns none.
        const joined = await User.orm().select('id', 'username').join(Topic, 'id', '=', 'created_by').get();

        const leftRows = await User.orm().select('id', 'username').leftJoin(Topic, 'id', '=', 'created_by').whereIn('username', ['mazlum', 'winter']).get();

        assert.deepEqual(joined.map((row) => row.username).sort(), ['mazlum', 'mergehez']);
        assert.deepEqual(joined.map((row) => row.title).sort(), ['first topic', 'second topic']);
        assert.deepEqual(leftRows.map((row) => row.username).sort(), ['mazlum', 'winter']);
    });
});
