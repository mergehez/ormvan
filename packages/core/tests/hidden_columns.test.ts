import { test } from '@japa/runner';
import type { OrmCreateData, OrmRow, OrmRowWithHidden } from '../src/index.js';
import { column, hiddenColumns, omitHidden, visibleColumns } from '../src/index.js';
import { FakeBaseModel, stubRawQuery } from './support/fakes.js';
import { ChatMessage, Topic, User } from './support/models.js';

/** A user row as the database returns it — hidden columns included. */
const STUB_USER_ROW = {
    id: 1,
    username: 'stub',
    email: 'stub@test.local',
    password: 'hash',
    password_sha: 'sha1',
    remember_token: null as string | null,
    created_at: 0,
};

test.group('orm hidden columns (metadata)', () => {
    test('hiddenColumns reflects each model declaration', ({ assert }) => {
        assert.deepEqual([...hiddenColumns(User)].sort(), ['password', 'password_sha', 'remember_token']);
        assert.deepEqual([...hiddenColumns(Topic)], ['mentions']);
        assert.isEmpty([...hiddenColumns(ChatMessage)]);
    });

    test('visibleColumns is every declared column minus the hidden ones', ({ assert }) => {
        const visible = visibleColumns(User);

        assert.includeMembers(visible, ['id', 'username', 'email']);
        assert.notIncludeMembers(visible, ['password', 'password_sha', 'remember_token']);
        assert.isAbove(visible.length, 0);
    });
});

test.group('orm hidden columns (projection)', (group) => {
    // No database: stub rawQuery so the tests can inspect the compiled SQL and the rows.
    group.setup(() => stubRawQuery(() => [[STUB_USER_ROW]]));

    test('User: the default projection lists visible columns and never the hidden ones', ({ assert }) => {
        const { sql } = User.orm().where('id', 1).toSQL();

        assert.include(sql, 'users.`username`');
        assert.notInclude(sql, 'password');
        assert.notInclude(sql, 'remember_token');
        assert.notInclude(sql, 'users.*');
    });

    test('User: withHidden adds only the requested columns', ({ assert }) => {
        const one = User.orm().withHidden('password').where('id', 1).toSQL().sql;
        assert.include(one, 'users.`password`');
        assert.notInclude(one, 'password_sha');
        assert.notInclude(one, 'remember_token');

        const two = User.orm().withHidden('password', 'remember_token').toSQL().sql;
        assert.include(two, 'users.`password`');
        assert.include(two, 'users.`remember_token`');
    });

    test('User: an explicit select() replaces the projection and may name a hidden column', ({ assert }) => {
        const selected = User.orm().select('id', 'username').toSQL().sql;
        assert.include(selected, 'username');
        assert.notInclude(selected, 'email');
        assert.notInclude(selected, 'password');

        // Naming a hidden column IS the opt-in, so this must not be an error.
        const named = User.orm().select('id', 'password').toSQL().sql;
        assert.include(named, 'password');
    });

    test('Topic: `mentions` is hidden by default and opt-in on demand', ({ assert }) => {
        assert.notInclude(Topic.orm().where('id', 1).toSQL().sql, 'mentions');
        assert.include(Topic.orm().withHidden('mentions').where('id', 1).toSQL().sql, 'mentions');
    });

    test('models without hidden columns still project an explicit column list', ({ assert }) => {
        const { sql } = ChatMessage.orm().toSQL();

        assert.include(sql, 'content');
        assert.notInclude(sql, 'chat_messages.*');
    });

    test('preloads are projected like the main query: hidden columns stay out of the JSON_OBJECT', ({ assert }) => {
        const { sql } = Topic.orm().preload('creator').toSQL();

        assert.include(sql, "'username', users.username");
        assert.notInclude(sql, 'users.password');
        assert.notInclude(sql, 'users.remember_token');
    });

    test('preloads honour a withHidden opt-in from the preload callback', ({ assert }) => {
        const { sql } = Topic.orm()
            .preloadCb('creator', (q) => q.withHidden('password', 'remember_token'))
            .toSQL();

        assert.include(sql, 'users.password');
        assert.include(sql, 'users.remember_token');
    });

    test('an explicit preload column list still wins over the projection', ({ assert }) => {
        const { sql } = Topic.orm().preload('creator', ['id', 'username']).toSQL();

        assert.include(sql, "'username', users.username");
        assert.notInclude(sql, "'avatar', users.avatar");
    });

    test('ORM rows are plain objects: nothing is attached to them', async ({ assert }) => {
        const row = await User.orm().where('id', 1).first();

        assert.exists(row);
        assert.notProperty(row, 'toJSON');
        assert.property(row, 'username');
    });

    test('omitHidden drops hidden columns at the response boundary', ({ assert }) => {
        const topic: Record<string, unknown> = { id: 5, title: 'a topic', mentions: [1, 2] };

        const publicTopic = omitHidden(Topic, topic);

        assert.notProperty(publicTopic, 'mentions');
        assert.equal(publicTopic.title, 'a topic');
        assert.deepEqual(topic.mentions, [1, 2], 'the original row is untouched');
    });

    test('an opted-in row is readable internally and stripped at the response boundary', async ({ assert }) => {
        const row = await User.orm().withHidden('password').where('id', 1).first();

        assert.exists(row);
        assert.equal(row?.password, 'hash'); // typed AND readable internally
        assert.notProperty(omitHidden(User, row), 'password'); // never handed to a client
    });

    test('models with nothing to hide are returned untouched', ({ assert }) => {
        class FakePlain extends FakeBaseModel {
            static table = 'fake_plain';

            @column() declare title: string;
        }

        const row: Record<string, unknown> = { id: 1, title: 'x' };

        assert.strictEqual(omitHidden(FakePlain, row), row, 'no copy when there is nothing to hide');
    });
});

test.group('orm hidden columns (preload types)', () => {
    test("a preloaded related row excludes the related model's hidden columns", async ({ assert, expectTypeOf }) => {
        const topic = await Topic.orm().preload('creator').first();
        type Creator = NonNullable<typeof topic>['creator'];

        expectTypeOf<Creator>().toHaveProperty('username');
        expectTypeOf<Creator>().not.toHaveProperty('password');
        expectTypeOf<Creator>().not.toHaveProperty('password_sha');
        expectTypeOf<Creator>().not.toHaveProperty('remember_token');

        const user = await User.orm().preload('created_users').first();
        type CreatedUsers = NonNullable<typeof user>['created_users'];

        expectTypeOf<CreatedUsers>().toBeArray();
        expectTypeOf<CreatedUsers[number]>().toHaveProperty('username');
        expectTypeOf<CreatedUsers[number]>().not.toHaveProperty('password');

        assert.isTrue(true);
    });

    test('a withHidden opt-in from the preload callback reaches the related row type', async ({ assert, expectTypeOf }) => {
        const topic = await Topic.orm()
            .preloadCb('creator', (q) => q.withHidden('password'))
            .first();
        type Creator = NonNullable<typeof topic>['creator'];

        expectTypeOf<Creator>().toHaveProperty('password');
        expectTypeOf<Creator>().not.toHaveProperty('password_sha');

        assert.isTrue(true);
    });

    test('an explicit preload column list narrows the related row type', async ({ assert, expectTypeOf }) => {
        const topic = await Topic.orm().preload('creator', ['id', 'username']).first();
        type Creator = NonNullable<typeof topic>['creator'];

        expectTypeOf<Creator>().toHaveProperty('username');
        expectTypeOf<Creator>().not.toHaveProperty('avatar');
        expectTypeOf<Creator>().not.toHaveProperty('password');

        assert.isTrue(true);
    });

    test("a paginated preload's items follow the same rule", async ({ assert, expectTypeOf }) => {
        const topic = await Topic.orm()
            .preloadCb('creator', (q) => q.paginating(10))
            .first();
        type Items = NonNullable<typeof topic>['creator']['items'];

        expectTypeOf<Items[number]>().toHaveProperty('username');
        expectTypeOf<Items[number]>().not.toHaveProperty('password');

        assert.isTrue(true);
    });

    test('reading a hidden column off a preloaded row is a compile error', async ({ assert }) => {
        const topic = await Topic.orm().preload('creator').first();

        if (topic) {
            // @ts-expect-error — `password` is hidden on the related model
            void topic.creator.password;
        }

        assert.isTrue(true);
    });
});

test.group('orm hidden columns (types)', () => {
    test('hidden columns are absent from the row type unless opted in', async ({ assert, expectTypeOf }) => {
        const row = await User.orm().where('id', 1).first();
        type Row = NonNullable<typeof row>;

        expectTypeOf<Row>().toHaveProperty('username');
        expectTypeOf<Row>().not.toHaveProperty('password');
        expectTypeOf<Row>().not.toHaveProperty('password_sha');
        expectTypeOf<Row>().not.toHaveProperty('remember_token');

        const optedIn = await User.orm().withHidden('password').first();
        type OptedInRow = NonNullable<typeof optedIn>;

        expectTypeOf<OptedInRow>().toHaveProperty('password');
        expectTypeOf<OptedInRow>().not.toHaveProperty('password_sha');

        assert.isTrue(true);
    });

    test('reading a hidden column without the opt-in is a compile error', async ({ assert }) => {
        const rows = await User.orm().get();
        const row = rows[0];

        if (row) {
            // @ts-expect-error — `password` is hidden: fetch it with withHidden('password')
            void row.password;
        }

        // @ts-expect-error — `email` is visible, so it cannot be opted into
        void User.orm().withHidden('email');

        assert.isTrue(true);
    });

    test('write payloads may set hidden columns, projections may not read them', ({ assert, expectTypeOf }) => {
        expectTypeOf<OrmCreateData<typeof User>>().toHaveProperty('password');
        expectTypeOf<OrmCreateData<typeof User>>().toHaveProperty('password_sha');

        assert.isTrue(true);
    });

    test('OrmRow excludes hidden columns, OrmRowWithHidden adds them back', ({ assert, expectTypeOf }) => {
        type Bare = OrmRow<typeof User>;
        expectTypeOf<Bare>().toHaveProperty('username');
        expectTypeOf<Bare>().not.toHaveProperty('password');
        expectTypeOf<Bare>().not.toHaveProperty('password_sha');
        expectTypeOf<Bare>().not.toHaveProperty('remember_token');

        // Default Keys = every hidden column of the model.
        type All = OrmRowWithHidden<typeof User>;
        expectTypeOf<All>().toHaveProperty('username');
        expectTypeOf<All>().toHaveProperty('password');
        expectTypeOf<All>().toHaveProperty('password_sha');
        expectTypeOf<All>().toHaveProperty('remember_token');

        // An explicit subset only adds back what was asked for.
        type JustPassword = OrmRowWithHidden<typeof User, 'password'>;
        expectTypeOf<JustPassword>().toHaveProperty('password');
        expectTypeOf<JustPassword>().not.toHaveProperty('password_sha');
        expectTypeOf<JustPassword>().not.toHaveProperty('remember_token');

        // A visible column is not a valid opt-in key.
        // @ts-expect-error — `email` is not hidden
        void (null as unknown as OrmRowWithHidden<typeof User, 'email'>);

        assert.isTrue(true);
    });

    test('withHidden can be chained, and widens only the named columns', async ({ assert, expectTypeOf }) => {
        const rows = await User.orm().withHidden('password').withHidden('remember_token').where('id', 1).get();
        type Row = (typeof rows)[number];

        expectTypeOf<Row>().toHaveProperty('password');
        expectTypeOf<Row>().toHaveProperty('remember_token');
        expectTypeOf<Row>().not.toHaveProperty('password_sha');

        assert.isTrue(true);
    });
});
