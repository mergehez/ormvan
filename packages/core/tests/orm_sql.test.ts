import { test } from '@japa/runner';
import { belongsTo, column, hasMany, hasManyThrough, manyToMany } from '../src/index.js';
import type { BelongsTo, HasMany, HasManyThrough, ManyToMany } from '../src/orm_relations.js';
import { assertThrows, FakeBaseModel, FakeBaseModelSoft, stubRawQuery } from './support/fakes.js';

const dbCalls: { sql: string; bindings: unknown[] }[] = [];
let emptyRows = false;

const { ormRaw, Orm } = await import('./support/executor.js');
const { colAs, sqlAs } = await import('../src/index.js');

test.group('orm sql tests', (group) => {
    // Japa has no `mock.module` — stub the db service's rawQuery for the group and
    // restore it on teardown (orm_builder calls db.rawQuery dynamically).
    group.setup(() =>
        stubRawQuery((sql, bindings) => {
            dbCalls.push({ sql, bindings });
            if (emptyRows) return [[], []];
            if (sql.startsWith('SELECT EXISTS')) return [[{ found: 1 }]];
            return [[{ total: 42 }]];
        })
    );

    // Regression for the dictionary_controller "Expected 5 bindings, saw 3" bug:
    // count() must pass ONLY where bindings, not the orderByRaw ones.

    test('whereWithOr — soft-deletable model is parenthesized behind the scope', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare status: number;
        }
        const b = new Orm(FakeTopic)
            .where('status', '=', 1)
            .whereWithOr([
                { column: 'title', operator: 'like', value: '%a%' },
                { column: 'title', value: 'exact' },
                { column: { sql: 'LOWER(title)' }, operator: '=', value: 'lower' },
            ])
            .limit(5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'topics.deleted_at IS NULL');
        assert.include(sql, '(topics.title like ? OR topics.title = ? OR LOWER(title) = ?)');
        assert.deepEqual(bindings, [1, '%a%', 'exact', 'lower']);
    });
    test('whereWithOr — non-soft-deletable model stays top-level', ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @column() declare username: string;
        }

        const b = new Orm(FakeUser).where('id', '<', 100).whereWithOr([
            { column: 'username', value: 'x' },
            { column: 'username', value: 'y' },
        ]);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, '(users.username = ? OR users.username = ?)');
        assert.include(sql, 'users.id < ? AND (users.username');
        assert.deepEqual(bindings, [100, 'x', 'y']);
    });
    test('whereRaw + orderBy + orderByRaw compile correctly (soft-deletable)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare status: number;
            @column() declare created_at: number;
        }

        const b = new Orm(FakeTopic)
            .where('status', '=', 1)
            .whereRaw('LOWER(title) = ?', ['abc'])
            .orderBy('id', 'desc')
            .orderByRaw('FIELD(title, ?)', ['x'])
            .orderBy('created_at')
            .limit(5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'WHERE topics.deleted_at IS NULL AND (topics.status = ? AND LOWER(title) = ?)');
        assert.include(sql, 'ORDER BY topics.id desc, FIELD(title, ?), topics.created_at asc');
        assert.include(sql, 'LIMIT 5');
        assert.deepEqual(bindings, [1, 'abc', 'x']);
    });
    test('latest() orders by the primary key, descending', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
        }

        const { sql } = new Orm(FakeTopic).where('id', '>', 0).latest().toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'ORDER BY topics.id desc');
    });
    test('orderBy replaces what it said before for the same column, in place', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
        }

        const { sql } = new Orm(FakeTopic).orderBy('title').orderBy('id', 'desc').orderBy('title', 'desc').toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'ORDER BY topics.title desc, topics.id desc');
        assert.notInclude(sql, 'topics.title asc', 'the column is not ordered twice');
    });
    test('latest() replaces an ordering the chain already had on the primary key', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
        }

        const { sql } = new Orm(FakeTopic).orderBy('id').latest().toSQL();

        assert.include(sql, 'ORDER BY topics.id desc');
        assert.notInclude(sql, 'topics.id asc', 'the primary key is ordered once');
    });
    test('latest() leaves the orderings of other columns alone', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
        }

        const { sql } = new Orm(FakeTopic).orderBy('title').latest().toSQL();

        assert.include(sql, 'ORDER BY topics.title asc, topics.id desc');
    });
    test('latest(column) and oldest(column) order by the column you name', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
            @column() declare created_at: number;
        }

        const newest = new Orm(FakeTopic).latest('created_at').toSQL();
        const oldest = new Orm(FakeTopic).oldest('created_at').toSQL();
        const oldestByKey = new Orm(FakeTopic).oldest().toSQL();

        assert.include(newest.sql, 'ORDER BY topics.created_at desc');
        assert.include(oldest.sql, 'ORDER BY topics.created_at asc');
        assert.include(oldestByKey.sql, 'ORDER BY topics.id asc');
        assert.notInclude(newest.sql, 'topics.id desc', 'naming a column means only that column');
    });
    test('latest() and oldest() replace each other on the same column', ({ assert }) => {
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
        }

        const { sql } = new Orm(FakeTopic).latest().oldest().toSQL();

        assert.include(sql, 'ORDER BY topics.id asc');
        assert.notInclude(sql, 'topics.id desc', 'the column is ordered once');
    });
    test('a hidden column can be ordered, grouped and filtered in HAVING', ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            static hiddenColumns = ['password'] as const;
            @column() declare username: string;
            @column() declare password: string;
        }

        const { sql } = new Orm(FakeUser).groupBy('password').having('password', '!=', '').orderBy('password').toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'GROUP BY users.password');
        assert.include(sql, 'HAVING users.password != ?');
        assert.include(sql, 'ORDER BY users.password asc');
    });
    test('every where-family method accepts a hidden column', ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            static hiddenColumns = ['password'] as const;
            @column() declare username: string;
            @column() declare password: string;
        }

        const { sql } = new Orm(FakeUser)
            .whereNot('password', 'a')
            .whereNull('password')
            .whereNotNull('password')
            .whereIn('password', ['b'])
            .whereNotIn('password', ['c'])
            .whereWithOr([{ column: 'password', value: 'd' }])
            .whereOneOfCols(['password'], '=', 'e')
            .whereTwoColumnsMatch(['password', 'username'], ['f', 'g'])
            .toSQL();

        assert.include(sql, 'users.password != ?');
        assert.include(sql, 'users.password IS NULL');
        assert.include(sql, 'users.password IS NOT NULL');
        assert.include(sql, 'users.password IN (?)');
        assert.include(sql, 'users.password NOT IN (?)');
    });
    test('the tail clauses accept a qualified column, for a join', ({ assert }) => {
        class FakeGame extends FakeBaseModel {
            static table = 'games';
            @column() declare title: string;
        }
        class FakeMove extends FakeBaseModel {
            static table = 'moves';
            @column() declare game_id: number;
        }

        const { sql } = new Orm(FakeMove)
            .join(FakeGame, 'game_id', '=', 'id')
            .where('games.title', 'like', 'a%')
            .groupBy('games.title')
            .having('games.title', '!=', '')
            .orderBy('games.title')
            .toSQL();

        assert.include(sql, 'INNER JOIN games ON moves.game_id = games.id');
        assert.include(sql, 'WHERE games.title like ?');
        assert.include(sql, 'GROUP BY games.title');
        assert.include(sql, 'HAVING games.title != ?');
        assert.include(sql, 'ORDER BY games.title asc');
    });
    test('countDistinct and q.ref accept a hidden column', async ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            static hiddenColumns = ['password'] as const;
            @column() declare username: string;
            @column() declare password: string;
        }

        dbCalls.length = 0;
        await new Orm(FakeUser).where('id', 1).countDistinct('password', 'distinct_passwords');
        assert.include(dbCalls.at(-1)!.sql, 'COUNT(DISTINCT users.password) AS distinct_passwords');

        dbCalls.length = 0;
        await new Orm(FakeUser).where('id', 1).updateAll((q) => ({ username: q.ref('password') }));
        assert.include(dbCalls.at(-1)!.sql, 'users.password');
    });
    test('whereRaw alone on plain model', ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
        }

        const b = new Orm(FakeUser).whereRaw('id % 2 = 0');
        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.include(sql, 'WHERE id % 2 = 0');
    });
    test('count() returns total and reuses the where', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare status: number;
        }

        const b = new Orm(FakeTopic).where('status', '=', 1);

        const total = await b.count();
        assert.equal(total, 42);
        assert.include(dbCalls[0].sql, 'SELECT COUNT(*) AS total FROM topics');
        assert.include(dbCalls[0].sql, 'topics.deleted_at IS NULL AND (topics.status = ?)');
        assert.deepEqual(dbCalls[0].bindings, [1]);
    });
    test('count() excludes orderBy bindings while get() keeps them', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeDictWord extends FakeBaseModel {
            static table = 'dict_words';
            @column() declare is_approved: number;
            @column() declare word: string;
            @column() declare from: string;
            @column() declare to: string;
        }

        const b = new Orm(FakeDictWord)
            .where('is_approved', 1)
            .whereRaw('MATCH(`word`) against(? in BOOLEAN mode)', ['abc*'])
            .whereRaw('`word` like ?', ['%abc%'])
            .orderByRaw('`from`, `to`, case when `word` = ? then 0 when `word` like ? then 1 else 2 end', ['abc', 'abc_%']);

        const total = await b.count();
        assert.equal(total, 42);
        assert.deepEqual(dbCalls[0].bindings, [1, 'abc*', '%abc%']); // only the 3 where bindings

        const { sql, bindings } = b.toSQL();
        const placeholders = (sql.match(/\?/g) || []).length;
        assert.equal(placeholders, 5); // 3 where + 2 orderBy
        assert.deepEqual(bindings, [1, 'abc*', '%abc%', 'abc', 'abc_%']);
    });
    test('select supports raw expressions with bindings, ordered before where/orderBy', ({ assert }) => {
        dbCalls.length = 0;
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare content: string;
        }

        const b = new Orm(FakeEntry)
            .select('id', { sql: 'SUBSTRING(content, 1, ?)', bindings: [100] })
            .where('id', '>', 5)
            .orderByRaw('FIELD(content, ?)', ['x'])
            .limit(3);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'SELECT\n  entries.id, SUBSTRING(content, 1, ?)\nFROM entries');
        assert.include(sql, 'WHERE entries.id > ?');
        assert.include(sql, 'ORDER BY FIELD(content, ?)');
        assert.equal((sql.match(/\?/g) || []).length, 3);
        assert.deepEqual(bindings, [100, 5, 'x']); // select -> where -> orderBy
    });
    test('select accepts spread values', ({ assert }) => {
        dbCalls.length = 0;
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare content: string;
        }

        const b = new Orm(FakeEntry)
            .select('id', { sql: 'SUBSTRING(content, 1, ?)', bindings: [50] })
            .where('id', '>', 1)
            .limit(2);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'SELECT\n  entries.id, SUBSTRING(content, 1, ?)\nFROM entries');
        assert.deepEqual(bindings, [50, 1]); // select -> where
    });
    test('select supports `col as alias` string form and colAs()', ({ assert }) => {
        dbCalls.length = 0;
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare content: string;
        }

        const b = new Orm(FakeEntry).select('id', 'id as target_id', colAs('content', 'body'), '0 as id');

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'SELECT\n  entries.id, entries.id AS target_id, entries.content AS body, 0 AS id\nFROM entries');
    });
    test('select supports number-literal aliases (`1 as answers_count` — no table prefix)', ({ assert }) => {
        dbCalls.length = 0;
        class FakeQuestion extends FakeBaseModel {
            static table = 'questions';
            @column() declare title: string;
        }

        const b = new Orm(FakeQuestion).select('id', 'title', '1 as answers_count', '1 as is_pinned');

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'SELECT\n  questions.id, questions.title, 1 AS answers_count, 1 AS is_pinned\nFROM questions');
        assert.notInclude(sql, 'questions.1');
    });
    test('select supports sqlAs (raw SQL with typed alias)', ({ assert }) => {
        dbCalls.length = 0;
        class FakeQuestion extends FakeBaseModel {
            static table = 'questions';
            @column() declare title: string;
        }

        const b = new Orm(FakeQuestion).select('id', sqlAs('(select count(*) from answers where answers.question_id = questions.id)', 'answers_count', 0));

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'SELECT\n  questions.id, (select count(*) from answers where answers.question_id = questions.id) AS answers_count\nFROM questions');
    });
    test('whereIn compiles an IN clause with bindings (empty list → IN (NULL))', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare status: number;
        }

        const b = new Orm(FakeTopic).whereIn('id', [1, 2, 3]).whereIn('title', []).where('status', '=', 1);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'topics.id IN (?, ?, ?)');
        assert.notInclude(sql, 'topics.title IN ');
        assert.equal((sql.match(/\?/g) || []).length, 4); // 3 IN + 1 status
        assert.deepEqual(bindings, [1, 2, 3, 1]);
    });
    test('chained select calls accumulate (radio `me` alias pattern)', ({ assert }) => {
        class FakeRadioSong extends FakeBaseModel {
            static table = 'radio_songs';
            @column() declare song: string;
            @column() declare artist: string;
        }

        const b = new Orm(FakeRadioSong).select('id', 'song', 'artist').select({ sql: 'IF(created_by=1, 1, 0)', as: 'me' });

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'SELECT\n  radio_songs.id, radio_songs.song, radio_songs.artist, IF(created_by=1, 1, 0) AS me\nFROM radio_songs');
    });
    test("chained select with select('*') resets to the model's columns", ({ assert }) => {
        class FakeRadioSong extends FakeBaseModel {
            static table = 'radio_songs';
            @column() declare song: string;
        }

        const b = new Orm(FakeRadioSong).select('id').select('*');

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        // `select('*')` resets the selection: the projection falls back to the model's
        // columns (all of them), which are now listed explicitly instead of `<table>.*`.
        assert.include(sql, 'radio_songs.`id`');
        assert.include(sql, 'radio_songs.`song`');
        assert.notInclude(sql, 'radio_songs.*');
    });
    test('if() conditionally applies the callback', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }

        const b = new Orm(FakeTopic)
            .if(true, (q) => q.where('id', '>', 10))
            .if(false, (q) => q.where('title', 'x'))
            .if(
                false,
                (q) => q.where('title', 'y'),
                (q) => q.where('id', '<', 0)
            );

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'topics.id > ?');
        assert.include(sql, 'topics.id < ?'); // noMatchCallback ran for the false condition
        assert.notInclude(sql, "title = 'x'");
        assert.notInclude(sql, "title = 'y'");
        assert.deepEqual(bindings, [10, 0]);
    });
    test('paginate returns a { meta, data } paginator', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare status: number;
        }

        const b = new Orm(FakeTopic).where('status', '=', 1);

        const page = await b.paginate(2, 10);

        assert.typeOf(page, 'object');
        assert.equal(page.total, 42);
        assert.equal(page.currentPage, 2);
        assert.equal(page.perPage, 10);
        assert.equal(page.lastPage, 5); // ceil(42/10)
        assert.equal(page.hasMorePages, true);
        assert.equal(page.items.length, 1); // mock returns 1 row

        assert.equal(page.total, 42);
        assert.equal(page.currentPage, 2);
        assert.isArray(page.items);

        // last executed query is the page fetch: LIMIT 10 OFFSET 10
        const lastSql = dbCalls[dbCalls.length - 1].sql;
        assert.include(lastSql, 'LIMIT 10');
        assert.include(lastSql, 'OFFSET 10');
    });
    test('withCount accepts a string alias (`withCount("entries", "items_count")`)', ({ assert }) => {
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
        }
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
            @hasMany(() => FakeEntry, { foreignKey: 'topic_id' }) declare entries: HasMany<typeof FakeEntry>;
        }

        const b = new Orm(FakeTopic).withCount('entries', 'items_count').where('id', '>', 0);

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.match(sql, /AS items_count/);
        assert.notMatch(sql, /AS entries_count/);
    });
    test('withCountOrdered joins a derived table and orders by the joined count', ({ assert }) => {
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare status: number;
        }
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @column() declare title: string;
            @hasMany(() => FakeEntry, { foreignKey: 'topic_id' }) declare entries: HasMany<typeof FakeEntry>;
        }

        const b = new Orm(FakeTopic).withCountOrdered('entries', (c) => c.where('entries.status', 1).as('items_count'), 10).select('id', 'title');

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.include(sql, 'INNER JOIN (SELECT');
        assert.include(sql, 'COUNT(*) AS items_count');
        assert.include(sql, 'entries.topic_id');
        assert.include(sql, 'entries.status = ?');
        assert.include(sql, 'GROUP BY entries.topic_id');
        assert.include(sql, 'ORDER BY items_count desc');
        assert.include(sql, 'LIMIT 10');
        // Joined count is selected into the row and used to order the parent.
        assert.include(sql, 'rc.items_count AS items_count');
        assert.include(sql, 'ORDER BY rc.items_count');
    });
    test('having filters on a withCount alias (randomBest pattern)', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModel {
            static table = 'entry_ratings';
            @column() declare target_id: number;
            @column() declare value: number;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare status: number;
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id' }) declare ratings: HasMany<typeof FakeEntryRating>;
        }

        const b = new Orm(FakeEntry)
            .where('status', 1)
            .withCount('ratings', (r) => r.where('value', 4).as('cepiks_count'))
            .having('cepiks_count', '>', 0)
            .orderByRaw('RAND()')
            .limit(15);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.match(sql, /AS cepiks_count/);
        assert.include(sql, 'WHERE entries.status = ?');
        assert.include(sql, 'HAVING cepiks_count > ?');
        assert.include(sql, 'ORDER BY RAND()');
        assert.include(sql, 'LIMIT 15');
        assert.deepEqual(bindings, [4, 1, 0]); // count-filter (value=4), where status, having > 0
    });
    test('firstOrFail throws E_ROW_NOT_FOUND when no row matches', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
        }

        const b = new Orm(FakeTopic).where('id', 1);

        emptyRows = false;
        const row = await b.firstOrFail();
        assert.ok(row); // mock returns a row

        emptyRows = true;
        try {
            await b.firstOrFail();
            assert.equal('should have thrown', 'but did not');
        } catch (e: any) {
            assert.equal(e.code, 'E_ROW_NOT_FOUND');
            assert.equal(e.status, 404);
        } finally {
            emptyRows = false;
        }
    });
    test('orWhere(callback) groups the callback clauses in parens and ORs them (book duplicate check)', ({ assert }) => {
        class FakeBook extends FakeBaseModelSoft {
            static table = 'books';
            @column() declare isbn: string;
            @column() declare title: string;
            @column() declare publishers: string;
        }

        const b = new Orm(FakeBook).where('isbn', '978-X').orWhere((qb) => {
            qb.where('title', 'Some Book');
            qb.whereRaw('JSON_CONTAINS(publishers, ?)', [JSON.stringify(['Acme'])]);
        });

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'books.isbn = ? OR (books.title = ? AND JSON_CONTAINS(publishers, ?))');
        assert.include(sql, 'books.deleted_at IS NULL'); // scope preserved
        assert.deepEqual(bindings, ['978-X', 'Some Book', JSON.stringify(['Acme'])]);
    });
    test('orWhere(callback) with a single clause keeps the group', ({ assert }) => {
        class FakeBook extends FakeBaseModel {
            static table = 'books';
            @column() declare title: string;
        }

        const b = new Orm(FakeBook).where('id', '>', 0).orWhere((qb) => {
            qb.where('title', 'x');
        });

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.include(sql, 'books.id > ? OR (books.title = ?)');
    });
    test('whereGrouped groups clauses in parens (chat betweenPair pattern)', ({ assert }) => {
        class FakeChatMessage extends FakeBaseModelSoft {
            static table = 'chat_messages';
            @column() declare created_by: number;
            @column() declare receiver_id: number;
        }

        const b = new Orm(FakeChatMessage).whereGrouped((q) =>
            q.whereGrouped((qb) => qb.where('created_by', 1).where('receiver_id', 2)).orWhere((qb) => qb.where('created_by', 2).where('receiver_id', 1))
        );

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'chat_messages.deleted_at IS NULL');
        assert.include(sql, 'AND (((chat_messages.created_by = ? AND chat_messages.receiver_id = ?) OR (chat_messages.created_by = ? AND chat_messages.receiver_id = ?)))');
        assert.deepEqual(bindings, [1, 2, 2, 1]);
    });
    test('whereGrouped with mixed AND/OR clauses preserves the connectors', ({ assert }) => {
        class FakeBook extends FakeBaseModel {
            static table = 'books';
            @column() declare title: string;
            @column() declare isbn: string;
        }

        const b = new Orm(FakeBook).where('id', '>', 0).whereGrouped((q) => q.where('title', 'a').orWhere('isbn', 'b'));

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'books.id > ? AND (books.title = ? OR books.isbn = ?)');
        assert.deepEqual(bindings, [0, 'a', 'b']);
    });
    test('whereGrouped with a single clause keeps the group', ({ assert }) => {
        class FakeBook extends FakeBaseModel {
            static table = 'books';
            @column() declare title: string;
        }

        const b = new Orm(FakeBook).where('id', '>', 0).whereGrouped((qb) => {
            qb.where('title', 'x');
        });

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.include(sql, 'books.id > ? AND (books.title = ?)');
    });
    test('whereNot compiles `column != value` (negated equality — duplicate-title / avatar checks)', ({ assert }) => {
        class FakeBook extends FakeBaseModel {
            static table = 'books';
            @column() declare title: string;
        }

        const b = new Orm(FakeBook).where('id', '>', 0).whereNot('title', 'x');
        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'books.id > ? AND books.title != ?');
        assert.deepEqual(bindings, [0, 'x']);
    });
    test('exists() runs SELECT EXISTS and returns a boolean', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeBook extends FakeBaseModelSoft {
            static table = 'books';
            @column() declare isbn: string;
        }

        const b = new Orm(FakeBook).where('isbn', '978-X');

        emptyRows = false;
        const yes = await b.exists();
        assert.equal(yes, true);
        assert.include(dbCalls[0].sql, 'SELECT EXISTS(SELECT 1 FROM books');
        assert.include(dbCalls[0].sql, 'books.deleted_at IS NULL AND (books.isbn = ?)');

        emptyRows = true;
        const no = await b.exists();
        assert.equal(no, false);
        emptyRows = false;
    });
    test('countDistinct runs SELECT COUNT(DISTINCT col) with the where and returns [{ alias: number }]', async ({ assert }) => {
        dbCalls.length = 0;
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare created_by: number;
        }

        const b = new Orm(FakeEntry).where('topic_id', 5);

        emptyRows = false;
        const rows = await b.countDistinct('created_by', 'total');
        assert.lengthOf(dbCalls, 1);
        assert.include(dbCalls[0].sql, 'SELECT COUNT(DISTINCT entries.created_by) AS total FROM entries');
        assert.include(dbCalls[0].sql, 'WHERE entries.topic_id = ?');
        assert.deepEqual(dbCalls[0].bindings, [5]);
        assert.deepEqual(rows, [{ total: 42 }]);

        emptyRows = true;
        const none = await b.countDistinct('created_by');
        assert.deepEqual(none, []);
        emptyRows = false;
    });
    test('ormRaw.get runs arbitrary SQL with bindings and returns all rows', async ({ assert }) => {
        dbCalls.length = 0;

        emptyRows = false;
        const rows = await ormRaw.get<{ total: number }>('SELECT COUNT(*) AS total FROM chat_messages WHERE receiver_id = ?', [5]);
        assert.lengthOf(dbCalls, 1);
        assert.equal(dbCalls[0].sql, 'SELECT COUNT(*) AS total FROM chat_messages WHERE receiver_id = ?');
        assert.deepEqual(dbCalls[0].bindings, [5]);
        assert.deepEqual(rows, [{ total: 42 }]);

        emptyRows = true;
        const none = await ormRaw.get('SELECT 1');
        assert.deepEqual(none, []);
        emptyRows = false;
    });
    test('ormRaw.first returns the first row (or null when empty)', async ({ assert }) => {
        dbCalls.length = 0;

        emptyRows = false;
        const row = await ormRaw.first<{ total: number }>('SELECT 1 AS total');
        assert.lengthOf(dbCalls, 1);
        assert.deepEqual(row, { total: 42 });

        emptyRows = true;
        const none = await ormRaw.first('SELECT 1');
        assert.isNull(none);
        emptyRows = false;
    });
    test("preloadCb emits a JSON preload with only the callback's selected columns", ({ assert }) => {
        class FakeAnswer extends FakeBaseModel {
            static table = 'answers';
            @column() declare question_id: number;
            @column() declare content: string;
            @column() declare created_by: number;
        }
        class FakeQuestion extends FakeBaseModel {
            static table = 'questions';
            @column() declare title: string;
            @hasMany(() => FakeAnswer, { foreignKey: 'question_id' }) declare answers: HasMany<typeof FakeAnswer>;
        }

        const b = new Orm(FakeQuestion).preloadCb('answers', (q) => q.select('id', 'content'));

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.match(sql, /JSON_OBJECT\('id', answers\.id, 'content', answers\.content\)/);
        assert.include(sql, 'AS answers');
        assert.include(sql, 'FROM answers WHERE answers.question_id = questions.id');
    });
    test('whereHas compiles an EXISTS subquery with the callback + child soft-delete', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare status: number;
            @belongsTo(() => FakeTopic, { foreignKey: 'topic_id' }) declare topic: BelongsTo<typeof FakeTopic>;
        }

        const b = new Orm(FakeEntry).where('status', 1).whereHas('topic', (tq) => tq.where('title', 'like', '%a%').whereRaw('json_contains(categories, json_array(?)) = 0', [11]));

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'EXISTS (SELECT 1 FROM topics WHERE topics.id = entries.topic_id AND topics.deleted_at IS NULL');
        assert.include(sql, 'AND (topics.title like ? AND json_contains(categories, json_array(?)) = 0)');
        assert.include(sql, 'WHERE entries.status = ? AND EXISTS');
        assert.deepEqual(bindings, [1, '%a%', 11]);
    });
    test('whereHas without a callback compiles a bare EXISTS (child soft-delete still applied)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
            @belongsTo(() => FakeTopic, { foreignKey: 'topic_id' }) declare topic: BelongsTo<typeof FakeTopic>;
        }

        const b = new Orm(FakeEntry).whereHas('topic');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'EXISTS (SELECT 1 FROM topics WHERE topics.id = entries.topic_id AND topics.deleted_at IS NULL)');
        assert.deepEqual(bindings, []);
    });
    test('whereIn accepts a builder subquery and groupBy compiles (pinned-questions pattern)', ({ assert }) => {
        class FakeAnswer extends FakeBaseModelSoft {
            static table = 'answers';
            @column() declare question_id: number;
            @column() declare is_pinned: boolean;
        }
        class FakeQuestion extends FakeBaseModelSoft {
            static table = 'questions';
            @column() declare title: string;
        }

        const sub = new Orm(FakeAnswer).select('question_id').where('is_pinned', true).groupBy('question_id');
        const b = new Orm(FakeQuestion).whereIn('id', sub).where('title', 'like', '%x%');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'questions.id IN (SELECT');
        assert.include(sql, 'answers.question_id');
        assert.include(sql, 'answers.deleted_at IS NULL');
        assert.include(sql, 'answers.is_pinned = ?');
        assert.include(sql, 'GROUP BY answers.question_id');
        assert.deepEqual(bindings, [true, '%x%']); // subquery binding first, then outer
    });
    test('hasMany with onQuery auto-applies the relation filter to preloads and counts (Entry cepiks/favs)', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModelSoft {
            static table = 'entry_ratings';
            @column() declare target_id: number;
            @column() declare faved: boolean;
            @column() declare value: number;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id', onQuery: (q) => q.where('faved', 1) })
            declare favs: HasMany<typeof FakeEntryRating>;
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id', onQuery: (q) => q.where('value', 2) })
            declare cepiks: HasMany<typeof FakeEntryRating>;
        }

        const b = new Orm(FakeEntry).withCount('favs').withCount('cepiks').preload('favs').where('id', 5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // count subqueries carry the onQuery filter
        assert.include(sql, 'AS favs_count');
        assert.include(sql, 'entry_ratings.faved = ?');
        assert.include(sql, 'entry_ratings.value = ?');
        assert.include(sql, 'entry_ratings.deleted_at IS NULL');
        // preload also carries it
        assert.include(sql, 'AS favs');
        // preload (faved) compiles before counts, so its binding comes first
        assert.deepEqual(bindings, [1, 1, 2, 5]);
    });
    test("a count callback's withTrashed drops the child filter, not the count's own scope", ({ assert }) => {
        class FakeRating extends FakeBaseModelSoft {
            static table = 'entry_ratings';
            @column() declare target_id: number;
        }
        class FakeEntry extends FakeBaseModelSoft {
            static table = 'entries';
            @hasMany(() => FakeRating, { foreignKey: 'target_id' })
            declare ratings: HasMany<typeof FakeRating>;
        }

        const live = new Orm(FakeEntry).withCount('ratings').toSQL();
        const trashed = new Orm(FakeEntry).withCount('ratings', (r) => r.withTrashed()).toSQL();
        console.log(`\nSQL:\n${trashed.sql}\nbindings:`, trashed.bindings);

        // The callback's decision travels with the count …
        assert.include(live.sql, 'entry_ratings.deleted_at IS NULL');
        assert.notInclude(trashed.sql, 'entry_ratings.deleted_at IS NULL');
        // … and only with it: the count itself is still on the live parent.
        assert.include(trashed.sql, 'entries.deleted_at IS NULL');
    });
    test('self-referencing belongsTo preload aliases the child table (Topic.redirected_topic)', ({ assert }) => {
        // Same-table relation: Topic.redirected_topic is a belongsTo to Topic itself.
        // The preload subquery must alias the child table (e.g. `redirected_topic`) so
        // its `FROM topics`/`topics.id` don't collide with the outer `topics` table.
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare redirect_to: number | null;
            @belongsTo(() => FakeTopic, { foreignKey: 'redirect_to' })
            declare redirected_topic: BelongsTo<typeof FakeTopic>;
        }

        const b = new Orm(FakeTopic)
            .whereNotNull('redirect_to')
            .preload('redirected_topic', ['id', 'title'])
            .orderBy('title', 'asc')
            .select('id', 'title', 'redirect_to', 'deleted_at');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // The preload subquery must use an alias for the child table, not the bare table name
        // (bare `topics` would collide with the outer `FROM topics`).
        assert.include(sql, 'FROM topics as redirected_topic WHERE redirected_topic.id = topics.redirect_to');
        assert.notInclude(sql, 'FROM redirected_topic');
        // JSON_OBJECT columns reference the aliased table
        assert.match(sql, /JSON_OBJECT\('id', redirected_topic\.id, 'title', redirected_topic\.title\)/);
        // the relation's soft-delete scope uses the alias
        assert.include(sql, 'redirected_topic.deleted_at IS NULL');
        // the outer query stays on the bare table
        assert.include(sql, 'FROM topics');
        assert.include(sql, 'topics.redirect_to IS NOT NULL');
        assert.include(sql, 'ORDER BY topics.title asc');
        assert.deepEqual(bindings, []);
    });
    test('already preloaded relations are excluded from possible preloads', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @belongsTo(() => FakeTopic, { foreignKey: 'redirect_to' })
            declare redirected_topic: BelongsTo<typeof FakeTopic>;
            @belongsTo(() => FakeTopic, { foreignKey: 'redirect_to' })
            declare another_topic: BelongsTo<typeof FakeTopic>;
        }

        // @ts-expect-error
        new Orm(FakeTopic).preload('redirected_topic').preload('redirected_topic');
    });
    test('self-referencing belongsTo whereHas aliases the child table (Topic.redirected_topic)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare redirect_to: number | null;
            @belongsTo(() => FakeTopic, { foreignKey: 'redirect_to' })
            declare redirected_topic: BelongsTo<typeof FakeTopic>;
        }

        const b = new Orm(FakeTopic).whereHas('redirected_topic');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // The EXISTS subquery must alias the child table (as the relation name) so its
        // `FROM topics`/`topics.id` don't collide with the outer `FROM topics`.
        assert.include(sql, 'EXISTS (SELECT 1 FROM topics as redirected_topic WHERE redirected_topic.id = topics.redirect_to');
        // the relation's soft-delete scope uses the alias
        assert.include(sql, 'redirected_topic.deleted_at IS NULL');
        assert.deepEqual(bindings, []);
    });
    test('self-referencing belongsTo withCount aliases the child table (Topic.redirected_topic)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
            @column() declare redirect_to: number | null;
            @belongsTo(() => FakeTopic, { foreignKey: 'redirect_to' })
            declare redirected_topic: BelongsTo<typeof FakeTopic>;
        }

        const b = new Orm(FakeTopic).withCount('redirected_topic');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // The COUNT subquery must alias the child table so it doesn't collide with the outer
        assert.include(sql, '(SELECT COUNT(*) FROM topics as redirected_topic WHERE redirected_topic.id = topics.redirect_to');
        // the relation's soft-delete scope uses the alias
        assert.include(sql, 'redirected_topic.deleted_at IS NULL');
        assert.deepEqual(bindings, []);
    });
    test('withTrashed() lifts the guard of the builder it is called on, and no other', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }
        class FakeEntry extends FakeBaseModelSoft {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare status: number;
            @belongsTo(() => FakeTopic, { foreignKey: 'topic_id' })
            declare topic: BelongsTo<typeof FakeTopic>;
        }

        const b = FakeEntry.orm()
            .withTrashed()
            .where('status', 1)
            .whereHas('topic', (tq) => tq.where('title', 'like', '%a%'))
            .preload('topic', ['id', 'title'])
            .withCount('topic');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // The outer builder's guard is lifted...
        assert.notInclude(sql, 'entries.deleted_at IS NULL');
        assert.include(sql, 'WHERE entries.status = ?');
        // ...and the whereHas, preload and count keep the scope of their own model
        assert.include(sql, 'EXISTS (SELECT 1 FROM topics WHERE topics.id = entries.topic_id AND topics.deleted_at IS NULL');
        assert.include(sql, 'AND topics.deleted_at IS NULL) AS topic');
        assert.include(sql, 'AND topics.deleted_at IS NULL) AS topic_count');
        assert.deepEqual(bindings, [1, '%a%']);
    });
    test('a subquery lifts its own guard only when its callback asks', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }
        class FakeEntry extends FakeBaseModelSoft {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare status: number;
            @belongsTo(() => FakeTopic, { foreignKey: 'topic_id' })
            declare topic: BelongsTo<typeof FakeTopic>;
        }

        const b = FakeEntry.orm()
            .withTrashed()
            .whereHas('topic', (tq) => tq.withTrashed().where('title', 'like', '%a%'))
            .preloadCb('topic', (q) => q.withTrashed().select('id', 'title'))
            .withCount('topic', (c) => c.withTrashed());

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.notInclude(sql, 'topics.deleted_at IS NULL');
        assert.deepEqual(bindings, ['%a%']);
    });
    test('related() pre-filters a builder on the parent instance FK (User.added_images profile pattern)', ({ assert }) => {
        class FakeCaps extends FakeBaseModelSoft {
            static table = 'caps';
            @column() declare created_by: number;
            @column() declare path: string;
        }
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @hasMany(() => FakeCaps, { foreignKey: 'created_by' })
            declare added_images: HasMany<typeof FakeCaps>;
        }

        const user = { id: 5 };
        const b = new Orm(FakeUser).related('added_images', user).orderBy('id', 'desc').where('path', 'like', '%x%');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'FROM caps');
        // soft-delete scope ANDed with the relation FK filter
        assert.include(sql, 'caps.deleted_at IS NULL AND (caps.created_by = ? AND caps.path like ?)');
        assert.include(sql, 'ORDER BY caps.id desc');
        assert.deepEqual(bindings, [5, '%x%']);
    });
    test('related() with a belongsTo relation filters on the parent FK (child PK)', ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @column() declare username: string;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare created_by: number;
            @belongsTo(() => FakeUser, { foreignKey: 'created_by' })
            declare creator: BelongsTo<typeof FakeUser>;
        }

        const entry = { id: 1, created_by: 9 };
        const b = new Orm(FakeEntry).related('creator', entry).select('id', 'username');

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'SELECT\n  users.id, users.username\nFROM users');
        assert.include(sql, 'WHERE users.id = ?');
        assert.deepEqual(bindings, [9]);
    });
    test('related() throws for hasManyThrough / manyToMany (not single-table relations)', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModel {
            static table = 'entry_ratings';
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
        }
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
        }
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @hasManyThrough([() => FakeEntryRating, () => FakeEntry], {
                foreignKey: 'topic_id',
                throughLocalKey: 'id',
                throughForeignKey: 'target_id',
            })
            declare ratings: HasManyThrough<typeof FakeEntryRating, typeof FakeEntry>;
            @manyToMany(() => FakeTopic)
            declare faved_topics: ManyToMany<typeof FakeTopic>;
        }

        assertThrows(assert, () => new Orm(FakeUser).related('ratings', { id: 5 }), /hasManyThrough/);
        assertThrows(assert, () => new Orm(FakeUser).related('faved_topics', { id: 5 }), /manyToMany/);
    });
    test('manyToMany preload emits a pivot INNER JOIN + JSON_ARRAYAGG (User.faved_topics pattern)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
            @column() declare title: string;
        }
        class FakeUser extends FakeBaseModelSoft {
            static table = 'users';
            @manyToMany(() => FakeTopic, {
                pivotTable: 'user_topic_interactions',
                localKey: 'id',
                pivotForeignKey: 'created_by',
                relatedKey: 'id',
                pivotRelatedForeignKey: 'target_id',
            })
            declare faved_topics: ManyToMany<typeof FakeTopic>;
        }

        const b = new Orm(FakeUser).preload('faved_topics', ['id', 'title']).where('id', 5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // joins the child through the pivot table on the pivot->related key
        assert.include(sql, 'FROM topics INNER JOIN user_topic_interactions ON user_topic_interactions.target_id = topics.id');
        // filter pivot rows by the parent PK
        assert.include(sql, 'WHERE user_topic_interactions.created_by = users.id');
        // related model soft-delete scope
        assert.include(sql, 'topics.deleted_at IS NULL');
        // JSON-array aggregate, aliased to the relation name
        assert.include(sql, 'AS faved_topics');
        assert.match(sql, /COALESCE\(JSON_ARRAYAGG\(JSON_OBJECT\('id', topics.id, 'title', topics.title\)\), JSON_ARRAY\(\)\)/);
        // outer where
        assert.include(sql, 'users.id = ?');
    });
    test('manyToMany withCount emits a COUNT(*) subquery through the pivot (user.faved_topics_count)', ({ assert }) => {
        class FakeTopic extends FakeBaseModelSoft {
            static table = 'topics';
        }
        class FakeUser extends FakeBaseModelSoft {
            static table = 'users';
            @manyToMany(() => FakeTopic, {
                pivotTable: 'user_topic_interactions',
                localKey: 'id',
                pivotForeignKey: 'created_by',
                relatedKey: 'id',
                pivotRelatedForeignKey: 'target_id',
            })
            declare faved_topics: ManyToMany<typeof FakeTopic>;
        }

        const b = new Orm(FakeUser).withCount('faved_topics').where('id', 5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'AS faved_topics_count');
        assert.include(sql, 'FROM topics INNER JOIN user_topic_interactions ON user_topic_interactions.target_id = topics.id');
        assert.include(sql, 'WHERE user_topic_interactions.created_by = users.id');
        assert.include(sql, 'topics.deleted_at IS NULL');
        assert.include(sql, 'users.id = ?');
    });
    test('preloadCb honors orderBy + limit inside the callback (User.entries lastCepiks pattern)', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModelSoft {
            static table = 'entry_ratings';
            @column() declare target_id: number;
            @column() declare receiver_id: number;
            @column() declare created_at: number;
        }
        // class FakeEntry extends FakeBaseModelSoft {
        //     static table = 'entries';
        //     @column() declare content: string;
        // }
        class FakeUser extends FakeBaseModelSoft {
            static table = 'users';
            @hasMany(() => FakeEntryRating, { foreignKey: 'receiver_id' })
            declare received_cepiks: HasMany<typeof FakeEntryRating>;
        }

        const b = new Orm(FakeUser).preloadCb('received_cepiks', (q) => q.select('id', 'created_at', 'target_id', 'receiver_id').orderBy('id', 'desc').limit(20)).where('id', 5);

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // the subquery carries the callback's ORDER BY (qualified to the child table) + LIMIT
        assert.include(sql, 'ORDER BY entry_ratings.id desc');
        assert.include(sql, 'LIMIT 20');
        // still a JSON array aggregate aliased to the relation
        assert.include(sql, 'AS received_cepiks');
        assert.include(sql, 'entry_ratings.receiver_id = users.id');
        assert.include(sql, 'users.id = ?');
    });
    test('a preload fallback substitutes a missing row in the SQL, so nested preloads get it too', ({ assert }) => {
        class FakeUser extends FakeBaseModelSoft {
            static table = 'users';
            @column() declare username: string;
        }
        class FakeQuestion extends FakeBaseModelSoft {
            static table = 'questions';
            @column() declare title: string;
            @belongsTo(() => FakeUser, { foreignKey: 'created_by' })
            declare creator: BelongsTo<typeof FakeUser>;
        }
        class FakeAnswer extends FakeBaseModelSoft {
            static table = 'answers';
            @column() declare question_id: number;
            @belongsTo(() => FakeUser, { foreignKey: 'created_by' })
            declare creator: BelongsTo<typeof FakeUser>;
            @belongsTo(() => FakeQuestion, { foreignKey: 'question_id' })
            declare question: BelongsTo<typeof FakeQuestion>;
        }

        const deletedUser = { id: -1, username: 'user-not-found' };
        const b = new Orm(FakeAnswer)
            .preload('creator', ['id', 'username'], deletedUser)
            .preloadCb('question', (q) => q.select('id', 'title').preload('creator', ['id', 'username'], deletedUser));

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'IFNULL((SELECT JSON_OBJECT(');
        assert.include(sql, 'CAST(? AS JSON)');
        // one wrapper per preload that declared a fallback: the outer creator, and the nested one inside `question`
        assert.equal(sql.match(/IFNULL\(/g)?.length, 2);
        // the fallback is bound, not written into the statement text
        assert.deepEqual(
            bindings.filter((binding) => typeof binding === 'string' && binding.startsWith('{')),
            ['{"id":-1,"username":"user-not-found"}', '{"id":-1,"username":"user-not-found"}']
        );

        // The row is not nullable where a fallback is given — no `!` needed at the call site.
        if (Date.now() < 0) {
            const row = b.first();
            void row.then((answer) => answer?.creator.username);
            // @ts-expect-error — a to-many's own "none" is `[]`: a fallback would have to replace the array.
            Topic.orm().preload('entries', ['id'], { id: -1 });
        }
    });
    test('select accepts a `distinct <col>` prefix → `SELECT DISTINCT table.col` (active-users pattern)', ({ assert }) => {
        class FakeSession extends FakeBaseModel {
            static table = 'sessions';
            @column() declare user_id: number;
            @column() declare expires_at: number;
        }

        const b = new Orm(FakeSession).whereNotNull('user_id').select('distinct user_id');
        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);

        assert.include(sql, 'SELECT\n  DISTINCT sessions.user_id\nFROM sessions');
        assert.include(sql, 'WHERE sessions.user_id IS NOT NULL');
    });
    test('preloadCb returning paginating defers the relation to a late IN query + FastPaginator (User.entries/added_images pattern)', async ({ assert }) => {
        class FakeCaps extends FakeBaseModelSoft {
            static table = 'caps';
            @column() declare created_by: number;
            @column() declare path: string;
        }
        class FakeUser extends FakeBaseModelSoft {
            static table = 'users';
            @hasMany(() => FakeCaps, { foreignKey: 'created_by' })
            declare added_images: HasMany<typeof FakeCaps>;
        }

        // The paginating callback CAN'T be a JSON aggregate — it must go through
        // latePreloads → applyLatePreloads at exec time. So `toSQL()` shows no preload
        // column; get() runs a separate `WHERE created_by IN (...) ` paginated query.
        const q = new Orm(FakeUser).where('id', 1).preloadCb('added_images', (sub) => sub.orderBy('id', 'desc').paginating(12, () => 2));

        // toSQL (main query only) must NOT contain the relation as a JSON aggregate
        const { sql } = q.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.notMatch(sql, /AS added_images/);

        // This test needs realistic rows (id present on the parent, then caps rows for
        // the late query) — override rawQuery just for this test.
        const calls: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            calls.push({ sql, bindings });
            if (sql.includes('FROM users')) return [[{ id: 1 }]]; // main query → one parent row
            if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 12 }]]; // count() → 12 caps
            return [[{ id: 10, created_by: 1, path: 'a.jpg' }]]; // the late caps IN query
        });

        const rows = await q.get();
        restore();
        console.log('\nrows:', rows, '\ncalls:', JSON.stringify(calls));

        const mainCall = calls.find((c) => c.sql.includes('FROM users'));
        const countCall = calls.find((c) => c.sql.startsWith('SELECT COUNT(*)'));
        const lateCall = calls.find((c) => c.sql.includes('caps.created_by IN') && c.sql.includes('ORDER BY'));
        assert.isDefined(mainCall, 'main query ran');
        assert.isDefined(countCall, 'relation count query ran');
        assert.isDefined(lateCall, 'relation IN query ran');
        assert.match(lateCall!.sql, /caps\.created_by IN \(\?\)/);
        assert.match(lateCall!.sql, /ORDER BY caps\.id desc/);
        // page 2, perPage 12 → OFFSET 12
        assert.match(lateCall!.sql, /LIMIT 12/);
        assert.match(lateCall!.sql, /OFFSET 12/);
        // the relation is attached as a FastPaginator to the parent row
        const paginator = rows[0].added_images;
        assert.isArray(paginator.items);
        assert.equal(paginator.total, 12);
        assert.equal(paginator.currentPage, 2);
    });
});
