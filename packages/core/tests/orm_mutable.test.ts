import { test } from '@japa/runner';
import { column, hasOne, jsonDec, PlainBaseModel, softDeleteScopes } from '../src/index.js';
import type { HasOne } from '../src/orm_relations.js';
import { FakeBaseModel, FakeBaseModelSoft, stubRawQuery } from './support/fakes.js';

const { Orm: OrmBuilder } = await import('./support/executor.js');
const { OrmRowNotFoundError } = await import('../src/index.js');

test.group('orm mutable first', (group) => {
    group.setup(() =>
        stubRawQuery((sql) => {
            if (sql.includes('FROM users')) return [[{ id: 5, username: 'mazlum', avatar: 'a.png' }]];
            return [[{ total: 1 }]];
        })
    );

    test('first(true) returns a row whose selected columns are writable and preloads/counts are readonly', async ({ assert, expectTypeOf }) => {
        class FakeDetail extends FakeBaseModel {
            static table = 'user_details';
            @column() declare from: string;
            @column() declare about: string;
        }
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @column() declare username: string;
            @column() declare avatar: string;
            @hasOne(() => FakeDetail, { foreignKey: 'user_id' })
            declare detail: HasOne<typeof FakeDetail>;
        }

        const user = await new OrmBuilder(FakeUser).select('id', 'username').preload('detail').withCount('detail').where('id', 5).firstMutable();

        assert.isNotNull(user);
        assert.equal(user!.id, 5);
        assert.equal(user!.username, 'mazlum');
        assert.equal(typeof user!.save, 'function');

        // Selected columns are writable.
        user!.username = 'new-username';
        assert.equal(user!.username, 'new-username');

        type MutableUser = NonNullable<typeof user>;
        expectTypeOf<MutableUser>().toHaveProperty('username');
        expectTypeOf<MutableUser>().toHaveProperty('save');
        expectTypeOf<MutableUser['username']>().toEqualTypeOf<string>();
        // @ts-expect-error preloaded relations are deeply readonly
        expectTypeOf<MutableUser['detail']>().toEqualTypeOf<{ from: string }>();
    });

    test('first(true) with no row returns null', async ({ assert }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @column() declare username: string;
        }

        const restore = stubRawQuery(() => [[], []]);
        const user = await new OrmBuilder(FakeUser).where('id', 999).firstMutable();
        restore();

        assert.isNull(user);
    });

    test('first() without mutable returns a plain row (no save method)', async ({ assert, expectTypeOf }) => {
        class FakeUser extends FakeBaseModel {
            static table = 'users';
            @column() declare username: string;
        }

        const user = await new OrmBuilder(FakeUser).where('id', 5).first();

        assert.isNotNull(user);
        assert.equal(user!.id, 5);
        // @ts-expect-error plain rows have no save()
        const _noSave: () => Promise<unknown> = user!.save;

        type PlainUser = NonNullable<typeof user>;
        // @ts-expect-error plain rows have no save()
        expectTypeOf<PlainUser>().toHaveProperty('save');
    });
});

test.group('orm mutable: a primary key that is not `id`', () => {
    /** Like the real `cache` table: keyed by `key`, and with no `id` column at all. */
    class FakeCache extends PlainBaseModel {
        static table = 'cache';
        static primaryKey = 'key';
        @column() declare key: string;
        @column() declare value: string;
    }

    test('save() writes the row by the model primary key, not `id`', async ({ assert }) => {
        const queries: { sql: string; bindings: unknown[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [[{ key: 'the-key', value: '"before"' }], []];
        });

        try {
            const row = await new OrmBuilder(FakeCache).where('key', 'the-key').firstMutable();
            assert.isNotNull(row);
            queries.length = 0;

            row!.value = '"after"';
            await row!.save();
        } finally {
            restore();
        }

        // A hardcoded `id` used to write `WHERE id = ?` (with an undefined binding), which threw and
        // left the row unwritten for any caller that swallowed the error.
        const update = queries.find((query) => query.sql.startsWith('UPDATE'));
        assert.isDefined(update, `expected an UPDATE, got ${JSON.stringify(queries)}`);
        assert.include(update!.sql, 'WHERE `key` = ?');
        assert.deepEqual(update!.bindings, ['"after"', 'the-key']);
    });

    test('refresh() re-reads the row by the model primary key', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [[{ key: 'the-key', value: '"fresh"' }], []];
        });

        const row = await new OrmBuilder(FakeCache).where('key', 'the-key').firstMutable();
        assert.isNotNull(row);

        queries.length = 0;
        await row!.refresh();
        restore();

        assert.lengthOf(queries, 1);
        // The lookup key is the model's primary key: with the hardcoded `id` this was
        // `WHERE cache.id = ?` bound to `undefined`.
        assert.deepEqual(queries[0].bindings, ['the-key']);
        assert.notInclude(queries[0].sql, '.id');
        assert.equal(row!.value, '"fresh"');
    });

    test('getMutable() hands out rows that can be changed and saved', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            if (sql.startsWith('SELECT')) {
                return [
                    [
                        { key: 'a', value: '"1"' },
                        { key: 'b', value: '"2"' },
                    ],
                    [],
                ];
            }
            if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }, []];
            return [[{ key: 'a', value: '"1-new"' }], []];
        });

        let rows: Array<{ key: string; value: string; save(): Promise<unknown> }> = [];
        try {
            rows = await new OrmBuilder(FakeCache).getMutable();
            assert.lengthOf(rows, 2);
            assert.equal(typeof rows[0].save, 'function', 'each row carries save()');

            rows[0].value = '"1-new"';
            await rows[0].save();
        } finally {
            restore();
        }

        const update = queries.find((q) => q.sql.startsWith('UPDATE'));
        assert.isDefined(update, `expected an UPDATE, got ${JSON.stringify(queries)}`);
        assert.include(update!.sql, 'WHERE `key` = ?');
        assert.deepEqual(update!.bindings, ['"1-new"', 'a'], 'only the changed row, only the changed column');
    });
});

test.group('bulk update', () => {
    /** The other groups declare their fakes inline, so this group needs its own. */
    class BulkUser extends FakeBaseModel {
        static table = 'users';
        @column() declare username: string;
        @column() declare name: string;
    }

    class BulkSoftUser extends FakeBaseModelSoft {
        static table = 'users';
        @column() declare name: string;
    }

    test('updateAll writes every matching row in ONE statement and returns the count', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 3 }, []];
        });

        let affected = 0;
        try {
            affected = await new OrmBuilder(BulkUser).where('username', 'a').updateAll({ name: 'bulk' });
        } finally {
            restore();
        }

        assert.equal(affected, 3, 'the driver-reported affectedRows');
        assert.lengthOf(queries, 1);
        assert.include(queries[0].sql, 'UPDATE `users` SET `name` = ?');
        assert.include(queries[0].sql, 'users.username = ?');
        assert.deepEqual(queries[0].bindings, ['bulk', 'a']);
    });

    test('updateAll ignores keys that are not writable columns', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            // `id` is the primary key and `computed` is not a column — neither may reach the SET list.
            await new OrmBuilder(BulkUser).where('username', 'a').updateAll({ name: 'x', id: 9, computed: true });
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'SET `name` = ?');
        assert.notInclude(queries[0].sql, '`id` = ?');
        assert.notInclude(queries[0].sql, 'computed');
        assert.deepEqual(queries[0].bindings, ['x', 'a']);
    });

    test('updateAll refuses a bulk update with no WHERE instead of rewriting the table', async ({ assert }) => {
        const restore = stubRawQuery(() => [{ affectedRows: 0 }, []]);
        try {
            await assert.rejects(() => new OrmBuilder(BulkUser).updateAll({ name: 'x' }), /without a WHERE clause/);
        } finally {
            restore();
        }
    });

    test('updateAll scopes a soft-deletable model to live rows, and withTrashed() lifts it', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await BulkSoftUser.orm().where('name', 'x').updateAll({ name: 'y' });
            await BulkSoftUser.orm().withTrashed().where('name', 'x').updateAll({ name: 'y' });
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'deleted_at IS NULL');
        assert.notInclude(queries[1].sql, 'deleted_at IS NULL');
    });

    test('delete() binds the app clock and the actor instead of MySQL’s NOW()', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await new OrmBuilder(BulkSoftUser).where('name', 'x').delete(7);
        } finally {
            restore();
        }

        // The old statement interpolated `NOW()` and the id: on these `bigint` columns MySQL stored the digits
        // of the datetime (`20260915175937`) without complaining.
        assert.include(queries[0].sql, 'SET `deleted_at` = ?, `deleted_by` = ?');
        assert.notInclude(queries[0].sql, 'NOW()');

        const [stamp, actor, whereValue] = queries[0].bindings as [number, number, string];
        assert.isNumber(stamp);
        assert.isAbove(stamp, 1_700_000_000, 'a unix timestamp, not the digits of a datetime');
        assert.equal(actor, 7);
        assert.equal(whereValue, 'x');
        assert.include(queries[0].sql, 'WHERE users.deleted_at IS NULL AND (users.name = ?)');
    });

    test('delete() asks for an actor only where a soft delete writes one down', async ({ assert }) => {
        if (Date.now() < 0) {
            // @ts-expect-error — a soft delete records the actor in `deleted_by`, so it is required here.
            BulkSoftUser.orm().where('name', 'x').delete();
            // @ts-expect-error — nothing records it on this model: `delete()` and `deleteBy()` take no actor.
            BulkUser.orm().where('name', 'x').delete(7);
            // @ts-expect-error
            BulkUser.orm().deleteBy(1, 7);
            BulkUser.orm().where('name', 'x').delete();
        }

        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await BulkUser.orm().where('name', 'x').delete();
            assert.equal(await BulkSoftUser.orm().deleteBy(1, 7), 1);
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'DELETE FROM `users`');
        assert.deepEqual(queries[0].bindings, ['x'], 'no stamp and no actor to bind');

        assert.include(queries[1].sql, 'SET `deleted_at` = ?, `deleted_by` = ?');
        assert.equal(queries[1].bindings[1], 7);
    });

    test('delete() writes the extra columns in the same statement as the stamp', async ({ assert }) => {
        /** The shape the apps use for "why": a hidden column, written by the delete itself. */
        class ReasonedUser extends BulkSoftUser {
            static table = 'users';
            static readonly hiddenColumns = ['delete_reason'] as const;
            @column() declare delete_reason: number | null;
        }

        if (Date.now() < 0) {
            // A hidden column is a write, not a projection: naming it here is fine.
            ReasonedUser.orm().where('name', 'x').delete(7, { delete_reason: 2 });
            // @ts-expect-error — not a column of this model.
            BulkSoftUser.orm().where('name', 'x').delete(7, { delete_reason: 2 });
        }

        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await ReasonedUser.orm().where('name', 'x').delete(7, { delete_reason: 2 });
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'SET `deleted_at` = ?, `deleted_by` = ?, `delete_reason` = ?');
        const [stamp, actor, reason, whereValue] = queries[0].bindings as [number, number, number, string];
        assert.isNumber(stamp);
        assert.equal(actor, 7);
        assert.equal(reason, 2, 'bound, like every other value');
        assert.equal(whereValue, 'x');
    });

    test('forceDelete() deletes for real, and only a soft-deletable model has it', async ({ assert }) => {
        if (Date.now() < 0) {
            // @ts-expect-error — a model that does not soft-delete has nothing to force past.
            BulkUser.orm().where('name', 'x').forceDelete();
            BulkSoftUser.orm().where('name', 'x').forceDelete();
        }

        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await BulkSoftUser.orm().where('name', 'x').forceDelete();
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'DELETE FROM `users`');
        assert.notInclude(queries[0].sql, 'deleted_at IS NULL', 'a hard delete has no live-row scope');
        assert.deepEqual(queries[0].bindings, ['x']);
    });

    test('restore() writes the configured columns back to NULL, scoped by the query', async ({ assert }) => {
        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 2 }, []];
        });

        try {
            assert.equal(await BulkSoftUser.orm().where('name', 'x').restore(), 2);
        } finally {
            restore();
        }

        assert.include(queries[0].sql, 'UPDATE `users` SET `deleted_at` = ?, `deleted_by` = ?');
        assert.include(queries[0].sql, 'WHERE users.name = ?');
        assert.deepEqual(queries[0].bindings, [null, null, 'x']);
    });

    test('restore() refuses a query with no WHERE, and a model that wired the scope without a config', async ({ assert }) => {
        if (Date.now() < 0) {
            // @ts-expect-error — `BulkUser` configures no soft delete, so `restore()` is not one of its scopes.
            BulkUser.orm().where('name', 'x').restore();
        }

        // The scopes can be wired by hand, without the config — the plan is what refuses then.
        class HandWiredUser extends BulkUser {
            static restore = softDeleteScopes.restore;
        }

        const restore = stubRawQuery(() => [{ affectedRows: 0 }, []]);
        try {
            await assert.rejects(() => BulkSoftUser.orm().restore(), /restore attempted without a WHERE clause/);
            await assert.rejects(() => HandWiredUser.orm().where('name', 'x').restore(), /'HandWiredUser': the model has no soft delete configured/);
        } finally {
            restore();
        }
    });

    test('updateAll runs beforeUpdate with the payload, and no original row', async ({ assert }) => {
        class HookedUser extends BulkUser {
            static table = 'users';
            static seen: { columns: string[]; original: unknown; stamped: number | null } = { columns: [], original: 'unset', stamped: null };

            static hooks = {
                beforeUpdate: (row: Record<string, unknown>, ctx: { original?: Record<string, unknown>; now: () => number }) => {
                    HookedUser.seen = { columns: Object.keys(row), original: ctx.original, stamped: (row.updated_at = ctx.now()) };
                },
            };
        }

        const restore = stubRawQuery(() => [{ affectedRows: 2 }, []]);
        try {
            HookedUser.seen = { columns: [], original: 'unset', stamped: null };
            await new OrmBuilder(HookedUser).where('name', 'x').updateAll({ name: 'y' });
        } finally {
            restore();
        }

        assert.deepEqual(HookedUser.seen.columns, ['name']);
        assert.isUndefined(HookedUser.seen.original, 'a bulk update has no single row to compare against');
        assert.isAbove(HookedUser.seen.stamped ?? 0, 0, 'the stamp the hook added is written');
    });

    test('withoutHooks("beforeUpdate") keeps the hook out of the statement', async ({ assert }) => {
        class HookedUser extends BulkUser {
            static table = 'users';
            @column() declare updated_at: number;
            static stamps: number[] = [];

            static hooks = {
                beforeUpdate: (row: Record<string, unknown>, ctx: { now: () => number }) => {
                    HookedUser.stamps.push((row.updated_at = ctx.now()));
                },
            };
        }

        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            HookedUser.stamps = [];
            await new OrmBuilder(HookedUser).where('name', 'a').updateAll({ name: 'y' });
            await new OrmBuilder(HookedUser).where('name', 'a').withoutHooks('beforeUpdate').updateAll({ name: 'y' });
        } finally {
            restore();
        }

        assert.include(queries[0].sql, '`updated_at` = ?');
        assert.notInclude(queries[1].sql, '`updated_at` = ?', 'a skipped hook adds nothing');
        assert.deepEqual(queries[1].bindings, ['y', 'a']);
        assert.lengthOf(HookedUser.stamps, 1, 'the hook did not run at all for the skipped statement');
    });

    test('withoutHooks("beforeUpdate") writes an updated_at the caller passed itself', async ({ assert }) => {
        class HookedUser extends BulkUser {
            static table = 'users';
            @column() declare updated_at: number;
            // The app's own idiom: stamp only when the caller did not.
            static hooks = {
                beforeUpdate: (row: Record<string, unknown>, ctx: { now: () => number }) => {
                    row.updated_at ??= ctx.now();
                },
            };
        }

        const queries: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            return [{ affectedRows: 1 }, []];
        });

        try {
            await new OrmBuilder(HookedUser).where('name', 'a').withoutHooks('beforeUpdate').updateAll({ name: 'y', updated_at: 123 });
        } finally {
            restore();
        }

        assert.include(queries[0].sql, '`updated_at` = ?', 'the skip overrules the hook, not the caller');
        assert.include(queries[0].bindings, 123);
    });
});

test.group('orm mutable real tests', () => {
    // The real-database variant of the mutable-row tests stays in the app that owns the schema: it is an integration
    // test, not an engine test.
});

/**
 * The four primary-key shortcuts: `find`, `findMutable`, `findOrFail`, `findOrFailMutable`.
 */
test.group('orm find shortcuts', () => {
    /** An `id`-keyed model on the example `users` table, so the compiled WHERE is easy to read. */
    class UserRow extends FakeBaseModel {
        static table = 'users';
        @column() declare username: string;
    }

    /** A string primary key that is not `id` (Laravel's `cache` table), so the shortcut cannot assume `id`. */
    class CacheRow extends PlainBaseModel {
        static table = 'cache';
        static primaryKey = 'key';
        @column() declare key: string;
        @column() declare value: string;
    }

    /** Records what each read compiles to, and answers with `rows`. */
    function stub(rows: Record<string, unknown>[]) {
        const statements: { sql: string; bindings: any[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            statements.push({ sql, bindings });
            return [rows, []];
        });
        return { statements, restore };
    }

    test('find and findMutable filter by the primary key, and differ only in mutability', async ({ assert }) => {
        const { statements, restore } = stub([{ id: 7, username: 'mazlum' }]);
        try {
            const plain = await new OrmBuilder(UserRow).find(7);
            const mutable = await new OrmBuilder(UserRow).findMutable(7);

            assert.equal(plain?.id, 7);
            // Both compile the same read — the difference is what the caller can do with the row.
            assert.equal(statements[0].sql, statements[1].sql);
            assert.deepEqual(statements[0].bindings, [7]);
            assert.match(statements[0].sql, /WHERE\s+users\.id = \?/);
            assert.notProperty(plain as object, 'save', 'a plain read hands out data only');
            assert.equal(typeof mutable?.save, 'function');
            assert.equal(typeof mutable?.refresh, 'function');
        } finally {
            restore();
        }
    });

    test('find and findMutable answer null when nothing matches', async ({ assert }) => {
        const { restore } = stub([]);
        try {
            assert.isNull(await new OrmBuilder(UserRow).find(7));
            assert.isNull(await new OrmBuilder(UserRow).findMutable(7));
        } finally {
            restore();
        }
    });

    test('findOrFail and findOrFailMutable throw the engine’s not-found error instead of returning null', async ({ assert }) => {
        const { restore } = stub([]);
        try {
            await assert.rejects(() => new OrmBuilder(UserRow).findOrFail(7), OrmRowNotFoundError);
            await assert.rejects(() => new OrmBuilder(UserRow).findOrFailMutable(7), OrmRowNotFoundError);
        } finally {
            restore();
        }
    });

    test('a model whose primary key is not `id` is filtered by its own key', async ({ assert }) => {
        const { statements, restore } = stub([{ key: 'the-key', value: '"v"' }]);
        try {
            const row = await new OrmBuilder(CacheRow).findOrFailMutable('the-key');

            assert.match(statements[0].sql, /WHERE\s+cache\.key = \?/);
            assert.deepEqual(statements[0].bindings, ['the-key']);
            assert.equal(row.key, 'the-key');
        } finally {
            restore();
        }
    });
});

/**
 * A row can be changed through its own values, not only by assignment: `row.settings.flags.beta = true`,
 * `row.mentions.push('x')`. `save()` lists the columns whose value differs from the row it read, and that
 * comparison is by reference, so the row has to hold nested values of its own or such a change is invisible
 * and the column is silently left as it was.
 */
test.group('orm mutable: a nested value changed in place', () => {
    class SettingsUser extends PlainBaseModel {
        static table = 'users';

        @column() declare username: string;
        @column(jsonDec) declare settings: { theme: string; flags: { beta: boolean } };
        @column(jsonDec) declare mentions: string[];
    }

    test('save() writes a json column whose object was changed in place', async ({ assert }) => {
        const queries: { sql: string; bindings: unknown[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            if (sql.startsWith('SELECT')) {
                return [[{ id: 7, username: 'mazlum', settings: { theme: 'dark', flags: { beta: false } }, mentions: ['a'] }], []];
            }
            return [{ affectedRows: 1 }, []];
        });

        try {
            const row = await new OrmBuilder(SettingsUser).where('id', 7).firstMutable();
            assert.isNotNull(row);
            queries.length = 0;

            row!.settings.flags.beta = true;
            row!.mentions.push('b');
            await row!.save();
        } finally {
            restore();
        }

        const update = queries.find((query) => query.sql.startsWith('UPDATE'));
        assert.isDefined(update, `expected an UPDATE, got ${JSON.stringify(queries)}`);
        assert.include(update!.sql, '`settings` = ?');
        assert.include(update!.sql, '`mentions` = ?');
        assert.deepEqual(update!.bindings, ['{"theme":"dark","flags":{"beta":true}}', '["a","b"]', 7]);
    });

    test('a column that was not touched is still left out of the write', async ({ assert }) => {
        const queries: { sql: string; bindings: unknown[] }[] = [];
        const restore = stubRawQuery((sql, bindings) => {
            queries.push({ sql, bindings });
            if (sql.startsWith('SELECT')) {
                return [[{ id: 7, username: 'mazlum', settings: { theme: 'dark', flags: { beta: false } }, mentions: ['a'] }], []];
            }
            return [{ affectedRows: 1 }, []];
        });

        try {
            const row = await new OrmBuilder(SettingsUser).where('id', 7).firstMutable();
            queries.length = 0;
            row!.settings.flags.beta = true;
            await row!.save();
        } finally {
            restore();
        }

        const update = queries.find((query) => query.sql.startsWith('UPDATE'));
        assert.isDefined(update);
        assert.notInclude(update!.sql, '`mentions` = ?', 'a copy is not a change');
        assert.notInclude(update!.sql, '`username` = ?');
    });

    test('an update hook sees `original` as the row was read, nested values included', async ({ assert }) => {
        const seen: { beta: boolean; mentions: string[] }[] = [];

        class HookedSettingsUser extends PlainBaseModel {
            static table = 'users';

            @column() declare username: string;
            @column(jsonDec) declare settings: { theme: string; flags: { beta: boolean } };
            @column(jsonDec) declare mentions: string[];

            static hooks = {
                beforeUpdate: (row: HookedSettingsUser, { original }: { original: Record<string, any> }) => {
                    // The documented promise: `original` is the row as it was read. Sharing the object graph
                    // with the row under change would show the value that was just set here.
                    seen.push({ beta: original.settings.flags.beta, mentions: [...original.mentions] });
                    row.username = 'stamped';
                },
            };
        }

        const restore = stubRawQuery((sql) => {
            if (sql.startsWith('SELECT')) {
                return [[{ id: 7, username: 'mazlum', settings: { theme: 'dark', flags: { beta: false } }, mentions: ['a'] }], []];
            }
            return [{ affectedRows: 1 }, []];
        });

        try {
            const row = await new OrmBuilder(HookedSettingsUser).where('id', 7).firstMutable();
            assert.isNotNull(row);
            row!.settings.flags.beta = true;
            row!.mentions.push('b');
            await row!.save();
        } finally {
            restore();
        }

        assert.deepEqual(seen, [{ beta: false, mentions: ['a'] }]);
    });
});
