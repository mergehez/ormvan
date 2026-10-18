/**
 * Model hooks: declared on the model, inherited from base models, and run by the engine around its own
 * reads and writes. Each model here exercises one hook family, so a failure points at one of them.
 */
import { test } from '@japa/runner';
import type { OrmHooks, OrmRow } from '../src/index.js';
import { Orm, transaction } from './support/executor.js';
import { stubRawQuery } from './support/fakes.js';
import { User } from './support/models.js';

/** `beforeRead` narrows the query, `afterRead` reshapes the rows. */
class FilteredUser extends User {
    static table = 'users';

    /**
     * Attached by `afterRead` (optional, so it stays out of the required write payload).
     */
    declare username_upper?: string;

    static hooks: OrmHooks<typeof FilteredUser> = {
        beforeRead: (q) => {
            q.where('username', 'hook-a');
        },
        afterRead: (rows) => rows.map((row) => ({ ...row, username_upper: row.username.toUpperCase() })),
    };
}

/** Inherits the filter above and adds its own — both have to run, in that order. */
class InheritedUser extends FilteredUser {
    static hooks: OrmHooks<typeof InheritedUser> = {
        beforeRead: (q) => {
            q.where('name', 'Hook');
        },
    };
}

/** Write hooks: stamp on the way in, observe on the way out. */
class StampedUser extends User {
    static table = 'users';

    static seen: { inserted: number[]; updated: number[] } = { inserted: [], updated: [] };

    static hooks: OrmHooks<typeof StampedUser> = {
        beforeInsert: (row, { now }) => {
            row.created_at = now();
            row.updated_at = now();
        },
        beforeUpdate: (row, { now }) => {
            row.updated_at = now();
        },
        afterInsert: (row) => {
            StampedUser.seen.inserted.push(row.id);
        },
        afterUpdate: (row) => {
            StampedUser.seen.updated.push(row.id);
        },
    };
}

/** `beforeUpdate` comparing against the row it read — the `@beforeUpdate` + `$dirty` idiom. */
class DiffAwareUser extends User {
    static table = 'users';

    static sawOriginal: unknown = null;
    static stamps: number[] = [];
    static changedKeys: string[] = [];

    static hooks: OrmHooks<typeof DiffAwareUser> = {
        beforeUpdate: (row, { original, now }) => {
            DiffAwareUser.sawOriginal = original?.id;
            // Only a truthy new value counts.
            const changed = Object.entries(row).filter(([key, value]) => !!value && value !== original?.[key]);
            DiffAwareUser.changedKeys = changed.map(([key]) => key);
            if (changed.length) DiffAwareUser.stamps.push((row.updated_at = now()));
        },
    };
}

/** Delete hooks: `beforeDelete` gets the row it may refuse, `afterDelete` the row that went. */
class DeletedUser extends User {
    static table = 'users';

    static deleted: { before: string[]; after: string[] } = { before: [], after: [] };

    static hooks: OrmHooks<typeof DeletedUser> = {
        beforeDelete: (row) => {
            DeletedUser.deleted.before.push(row.username);
        },
        afterDelete: (row) => {
            DeletedUser.deleted.after.push(row.username);
        },
    };
}

/** `beforeDelete` keeping a row — the one thing a delete hook can decide. */
class GuardedDeleteUser extends User {
    static table = 'users';

    static hooks: OrmHooks<typeof GuardedDeleteUser> = {
        beforeDelete: (row) => {
            if (row.username === 'hook-system') throw new Error('a system user cannot be deleted');
            if (row.username === 'hook-keep') return false;
        },
    };
}

/** A delete hook that keeps its row by writing it itself first. */
class RetiredDeleteUser extends User {
    static table = 'users';

    static hooks: OrmHooks<typeof RetiredDeleteUser> = {
        beforeDelete: async (row, ctx) => {
            if (row.username !== 'hook-retire') return;

            // A delete hook's row is a snapshot, so the row that should survive is written by the hook itself.
            await RetiredDeleteUser.orm(ctx.client).where('id', row.id).updateAll({ name: 'Retired' });
            return false;
        },
    };
}

/**
 * A cascade-shaped model: the delete hooks record what the statement told them (was the row marked? for whom?), and
 * the restore hooks record the rows that came back.
 */
class InformedDeleteUser extends User {
    static table = 'users';

    static seen: { soft: boolean; by: number | string | null; username: string }[] = [];
    static restored: string[] = [];
    static narrowedFirst = false;

    static hooks: OrmHooks<typeof InformedDeleteUser> = {
        beforeDelete: (row, ctx) => {
            InformedDeleteUser.seen.push({ soft: ctx.softDelete, by: ctx.deletedBy, username: row.username });
        },
        beforeRestore: (q) => {
            InformedDeleteUser.narrowedFirst = true;
            q.whereNotNull('username');
        },
        afterRestore: (rows) => {
            InformedDeleteUser.restored = rows.map((row) => row.username);
        },
    };
}

/** `beforeInsert` changing the payload it is handed. */
class WritingInsertUser extends User {
    static table = 'users';

    static hooks: OrmHooks<typeof WritingInsertUser> = {
        beforeInsert: (row) => {
            if (row.username === 'hook-inserted') row.name = 'Written by the hook';
        },
    };
}

/** `beforeInsert` doing the work itself and handing the row back — `afterInsert` runs anyway. */
class DoneInsertUser extends User {
    static table = 'users';

    static afterSaw: unknown[] = [];

    static hooks: OrmHooks<typeof DoneInsertUser> = {
        beforeInsert: (row) => (row.username === 'hook-cached' ? { done: { ...(row as OrmRow<typeof DoneInsertUser>), id: 4242 } } : undefined),
        afterInsert: (row) => {
            DoneInsertUser.afterSaw.push(row.id);
        },
    };
}

/** `beforeUpdate` writing the row itself on the mutable path — `afterUpdate` runs anyway. */
class DoneRowUpdateUser extends User {
    static table = 'users';

    static afterSaw: unknown[] = [];

    static hooks: OrmHooks<typeof DoneRowUpdateUser> = {
        beforeUpdate: (row, { original }) => (row.name === 'done-row' ? { done: { ...(original as OrmRow<typeof DoneRowUpdateUser>), name: 'written-by-hook' } } : undefined),
        afterUpdate: (row) => {
            DoneRowUpdateUser.afterSaw.push(row.name);
        },
    };
}

/** `beforeUpdate` changing the columns it is handed. */
class WritingUpdateUser extends User {
    static table = 'users';

    static hooks: OrmHooks<typeof WritingUpdateUser> = {
        beforeUpdate: (row) => {
            if (row.name === 'change-me') row.email = 'hooked@example.com';
        },
    };
}

/** `beforeUpdate` doing the bulk work itself and reporting a count. */
class DoneUpdateUser extends User {
    static table = 'users';

    static hooks: OrmHooks<typeof DoneUpdateUser> = {
        beforeUpdate: (row) => (row.name === 'handled-me' ? { done: 7 } : undefined),
    };
}

/** `afterDelete` invalidating a cache: on the last row of the delete, not on every row. */
class LastRowDeleteUser extends User {
    static table = 'users';

    static invalidations: string[] = [];

    static perRow: string[] = [];

    static hooks: OrmHooks<typeof LastRowDeleteUser> = {
        afterDelete: (row, ctx) => {
            LastRowDeleteUser.perRow.push(row.username);
            if (ctx.isLastCall) LastRowDeleteUser.invalidations.push('entries');
        },
    };
}

/** Records whether a read ran inside a transaction. */
class TxAwareUser extends User {
    static table = 'users';

    static sawClient: boolean[] = [];

    static hooks: OrmHooks<typeof TxAwareUser> = {
        beforeRead: (_q, ctx) => {
            TxAwareUser.sawClient.push(ctx.client !== undefined);
        },
    };
}

/** Records the `phase` of every read, so the name a read reports can be asserted. */
class PhaseAwareUser extends User {
    static table = 'users';

    static phases: string[] = [];

    static hooks: OrmHooks<typeof PhaseAwareUser> = {
        beforeRead: (_q, { phase }) => {
            PhaseAwareUser.phases.push(phase ?? 'none');
        },
    };
}

/** A model with engine hooks and a mirrored column list: its hooks run through the engine's own SQL. */
class MirroredUser extends User {
    static table = 'users';

    static ran: string[] = [];

    static hooks: OrmHooks<typeof MirroredUser> = {
        afterInsert: (row) => {
            MirroredUser.ran.push(`engine:${row.id}`);
        },
    };
}

const base = { name: 'Hook', email: 'hook@example.com', created_at: 0, created_by: 0, updated_at: 0 };

/** Seeds one user, clearing any previous copy of it first. */
async function seedUser(username: string) {
    await User.orm().withTrashed().where('username', username).delete(null);
    await User.orm().upsert({ ...base, username });
}

/**
 * Hooks that make their statement match nothing and record that they ran — so a skipped hook shows up as
 * "the statement found what the hook would have hidden", and every other hook as an entry in `ran`.
 */
class SkipProbeUser extends User {
    static table = 'users';

    static ran: string[] = [];

    static hooks: OrmHooks<typeof SkipProbeUser> = {
        beforeRead: (q) => {
            SkipProbeUser.ran.push('beforeRead');
            q.where('username', 'no-such-user');
        },
        afterRead: () => {
            SkipProbeUser.ran.push('afterRead');
        },
        beforeDelete: (row) => {
            SkipProbeUser.ran.push(`beforeDelete:${row.username}`);
        },
        afterDelete: (row) => {
            SkipProbeUser.ran.push(`afterDelete:${row.username}`);
        },
    };
}

/**
 * The clock the spec installs: `Orm.configure({ now })` is what a hook stamps with, and `Orm.create(...)` uses it.
 */
const SPEC_CLOCK = 1_700_000_000;

test.group('model hooks', (group) => {
    group.setup(async () => {
        for (const model of [
            FilteredUser,
            InheritedUser,
            StampedUser,
            DeletedUser,
            GuardedDeleteUser,
            RetiredDeleteUser,
            WritingInsertUser,
            DoneInsertUser,
            WritingUpdateUser,
            DoneUpdateUser,
            DoneRowUpdateUser,
            LastRowDeleteUser,
            TxAwareUser,
            DiffAwareUser,
            PhaseAwareUser,
        ]) {
            if (!model.booted) model.boot();
        }
        // Seed through `upsert` — the raw write that deliberately bypasses the write hooks.
        for (const username of ['hook-a', 'hook-b', 'hook-delete']) {
            await User.orm().withTrashed().where('username', username).delete(null);
            await User.orm().upsert({ ...base, username });
        }
    });

    test('beforeRead narrows every read (count and exists included)', async ({ assert }) => {
        const rows = await FilteredUser.orm().get();

        assert.lengthOf(rows, 1);
        assert.equal(rows[0].username, 'hook-a');
        assert.equal(await FilteredUser.orm().count(), 1);
        assert.isTrue(await FilteredUser.orm().exists());
    });

    test('afterRead reshapes the rows it is given', async ({ assert, expectTypeOf }) => {
        const rows = await FilteredUser.orm().get();

        expectTypeOf<(typeof rows)[number]>().toHaveProperty('username_upper');
        assert.equal(rows[0].username_upper, 'HOOK-A');
    });

    test('ctx.phase names the read that fired the hook', async ({ assert }) => {
        PhaseAwareUser.phases = [];

        await PhaseAwareUser.orm().where('username', 'hook-a').get();
        await PhaseAwareUser.orm().where('username', 'hook-a').first();
        await PhaseAwareUser.orm().count();
        await PhaseAwareUser.orm().countDistinct('id');
        await PhaseAwareUser.orm().exists();
        // A chain that delegates reports the read it ends up in.
        await PhaseAwareUser.orm()
            .where('username', 'hook-a')
            .getMap((row) => row.id);
        // A chain that delegates reports the read it ends up in — and a paginated read is ONE read, not a count
        // plus a get, so both of its statements share a single pair of hooks.
        await PhaseAwareUser.orm().paginate(1, 5);

        assert.deepEqual(PhaseAwareUser.phases, ['get', 'first', 'count', 'countDistinct', 'exists', 'get', 'paginate']);
    });

    test('a paginated read narrows the count and the page alike', async ({ assert }) => {
        const page = await FilteredUser.orm().paginate(1, 5);

        assert.equal(page.total, 1, 'the count honoured beforeRead');
        assert.lengthOf(page.items, 1, 'so did the page query');
    });

    test('a subclass runs its own hooks and its base model’s', async ({ assert }) => {
        const rows = await InheritedUser.orm().get();

        // Both filters apply: the base's username and the subclass's name.
        assert.lengthOf(rows, 1);
        assert.equal(rows[0].username, 'hook-a');
        assert.equal(rows[0].name, 'Hook');
    });

    test('beforeInsert and afterInsert run around Orm.create', async ({ assert }) => {
        StampedUser.seen.inserted = [];

        const created = await Orm.create(StampedUser, { ...base, password: '', username: `hook-insert-${Date.now()}` });

        assert.isAbove(created.created_at, 0, 'beforeInsert stamped created_at');
        assert.deepEqual(StampedUser.seen.inserted, [created.id]);
    });

    test('create() stamps with the configured clock, so hooks see it', async ({ assert }) => {
        const configured = Orm.configure({ now: () => SPEC_CLOCK });
        try {
            const created = await Orm.create(StampedUser, { ...base, password: '', username: `hook-clock-${Date.now()}` });

            assert.equal(created.created_at, SPEC_CLOCK, 'the hook stamped the configured clock');
        } finally {
            Orm.configure(configured);
        }
    });

    test('beforeUpdate and afterUpdate run around a mutable save()', async ({ assert }) => {
        StampedUser.seen.updated = [];

        const row = await StampedUser.orm().where('username', 'hook-a').firstMutable();
        assert.isNotNull(row);
        row!.name = 'Hook saved';
        await row!.save();

        assert.isAbove(row!.updated_at, 0);
        assert.deepEqual(StampedUser.seen.updated, [row!.id]);
    });

    test('beforeUpdate sees the row as it was read, so a hook can tell what changed', async ({ assert }) => {
        const row = await DiffAwareUser.orm().where('username', 'hook-a').firstMutable();
        assert.isNotNull(row);

        DiffAwareUser.sawOriginal = null;
        DiffAwareUser.stamps = [];

        // A save() that changes nothing still runs the hook (that is where `updated_at` would be
        // stamped), but the hook can see nothing moved and leave it alone.
        await row!.save();
        assert.equal(DiffAwareUser.sawOriginal, row!.id, 'the hook saw the row as it was read');
        assert.deepEqual(DiffAwareUser.changedKeys, [], 'nothing changed, so nothing was stamped');
        assert.deepEqual(DiffAwareUser.stamps, []);

        // A real change stamps.
        row!.name = 'Hook diffed';
        await row!.save();

        assert.lengthOf(DiffAwareUser.stamps, 1);
        assert.isAbove(row!.updated_at, 0);
    });

    test('delete hooks see the row each statement removes', async ({ assert }) => {
        DeletedUser.deleted = { before: [], after: [] };

        assert.equal(await DeletedUser.orm().withTrashed().where('username', 'hook-delete').delete(null), 1);
        assert.deepEqual(DeletedUser.deleted, { before: ['hook-delete'], after: ['hook-delete'] });
    });

    test('a delete hook keeps its row, and the count says so', async ({ assert }) => {
        await seedUser('hook-keep');
        await seedUser('hook-retire');

        assert.equal(await GuardedDeleteUser.orm().withTrashed().where('username', 'hook-keep').delete(null), 0, 'kept: not counted');
        assert.isNotNull(await User.orm().withTrashed().where('username', 'hook-keep').first(), 'the row is still there');

        // The hook wrote the row itself, then kept it: nothing was deleted for it either.
        assert.equal(await RetiredDeleteUser.orm().withTrashed().where('username', 'hook-retire').delete(null), 0);
        assert.equal((await User.orm().withTrashed().where('username', 'hook-retire').first())?.name, 'Retired');
    });

    test('a delete hook is told whether the row was marked, and for whom', async ({ assert }) => {
        await seedUser('hook-informed');
        InformedDeleteUser.seen = [];

        // The model has a config, so the statement marks the row and writes the actor into `deleted_by`.
        assert.equal(await InformedDeleteUser.orm().where('username', 'hook-informed').delete(7), 1);
        assert.deepEqual(InformedDeleteUser.seen, [{ soft: true, by: 7, username: 'hook-informed' }]);

        // `forceDelete()` removes the row for real: nothing holds an actor.
        await seedUser('hook-informed-hard');
        await InformedDeleteUser.orm().where('username', 'hook-informed-hard').forceDelete();
        assert.deepEqual(InformedDeleteUser.seen[1], { soft: false, by: null, username: 'hook-informed-hard' });

        // The other half of the contract: a path that cannot fill a field does not offer it. Each of these is a
        // compile error, so this block only ever runs if the types changed.
        if (Date.now() < 0) {
            class WrongCtxUser extends InformedDeleteUser {
                static hooks: OrmHooks<typeof WrongCtxUser> = {
                    // @ts-expect-error — an insert hook is told nothing about a delete.
                    beforeInsert: (_row, ctx) => void ctx.softDelete,
                    // @ts-expect-error — and an update hook has no `phase`.
                    beforeUpdate: (_row, ctx) => void ctx.phase,
                    // @ts-expect-error — nor does a delete hook.
                    beforeDelete: (_row, ctx) => void ctx.phase,
                    // @ts-expect-error — `original` belongs to the update path.
                    afterDelete: (_row, ctx) => void ctx.original,
                };
            }
            assert.isFunction(WrongCtxUser);
        }
    });

    test('restore runs its hook pair around ONE statement, and afterRestore gets the rows', async ({ assert }) => {
        const queries: string[] = [];
        const restore = stubRawQuery((sql) => {
            queries.push(sql);
            return sql.startsWith('SELECT') ? [[{ id: 1, username: 'hook-restore' }], []] : [{ affectedRows: 1 }, []];
        });

        try {
            InformedDeleteUser.restored = [];
            InformedDeleteUser.narrowedFirst = false;

            assert.equal(await InformedDeleteUser.orm().where('username', 'hook-restore').restore(), 1);
        } finally {
            restore();
        }

        // `beforeRestore` saw the query, `afterRestore` the rows the SELECT found, then the statement ran.
        assert.isTrue(InformedDeleteUser.narrowedFirst);
        assert.deepEqual(InformedDeleteUser.restored, ['hook-restore']);
        assert.match(queries[0], /^SELECT/);
        assert.match(queries[1], /^UPDATE/);
    });

    test('restore reads no rows when nothing wants them', async ({ assert }) => {
        const queries: string[] = [];
        const restore = stubRawQuery((sql) => {
            queries.push(sql);
            return [{ affectedRows: 1 }, []];
        });

        try {
            InformedDeleteUser.restored = ['stale'];
            // `User` declares no restore hooks at all: one statement, no read ahead of it.
            await User.orm().where('username', 'hook-plain').restore();
            assert.equal(queries.length, 1);
            assert.match(queries[0], /^UPDATE/);

            // Skipping the pair is the same: the row read exists only for `afterRestore`.
            queries.length = 0;
            await InformedDeleteUser.orm().where('username', 'hook-skipped').withoutHooks('beforeRestore', 'afterRestore').restore();

            assert.deepEqual(InformedDeleteUser.restored, ['stale'], 'the hook did not run');
            assert.equal(queries.length, 1);
            assert.match(queries[0], /^UPDATE/);
        } finally {
            restore();
        }
    });

    test('beforeInsert changes the payload it is handed', async ({ assert }) => {
        const before = await User.orm().count();

        const row = await Orm.create(WritingInsertUser, { ...base, username: 'hook-inserted', password: '' });

        assert.equal(row.name, 'Written by the hook', "the hook's value, not the payload's");
        assert.equal(await User.orm().count(), before + 1, 'the insert ran');
    });

    test('beforeUpdate changes the columns it is handed, for one row and for a whole statement', async ({ assert }) => {
        await seedUser('hook-write-update');

        const row = await WritingUpdateUser.orm().where('username', 'hook-write-update').firstOrFailMutable();
        row.name = 'change-me';
        await row.save();
        const saved = await User.orm().where('username', 'hook-write-update').first();
        assert.equal(saved?.name, 'change-me', "the caller's change still went");
        assert.equal(saved?.email, 'hooked@example.com', "and the hook's column with it");

        await seedUser('hook-bulk-update');
        assert.equal(await WritingUpdateUser.orm().where('username', 'hook-bulk-update').updateAll({ name: 'change-me' }), 1, 'the statement ran');
        const bulk = await User.orm().where('username', 'hook-bulk-update').first();
        assert.equal(bulk?.name, 'change-me');
        assert.equal(bulk?.email, 'hooked@example.com', 'the hook reaches every row of the statement');
    });

    test('beforeInsert can do the work itself and hand the row back', async ({ assert }) => {
        const before = await User.orm().count();
        DoneInsertUser.afterSaw = [];

        const row = await Orm.create(DoneInsertUser, { ...base, username: 'hook-cached', password: '' });

        assert.equal(row.id, 4242, 'the row the hook handed back');
        assert.equal(await User.orm().count(), before, 'nothing was inserted');
        assert.deepEqual(DoneInsertUser.afterSaw, [4242], 'afterInsert ran anyway, with the same row');
    });

    test('afterUpdate runs even when beforeUpdate did the write itself', async ({ assert }) => {
        await seedUser('hook-done-row');
        const seeded = await DoneRowUpdateUser.orm().where('username', 'hook-done-row').firstOrFail();
        DoneRowUpdateUser.afterSaw = [];

        const row = await Orm.update(DoneRowUpdateUser, seeded.id, { name: 'done-row' });

        assert.equal(row.name, 'written-by-hook', 'the row the hook handed back');
        assert.deepEqual(DoneRowUpdateUser.afterSaw, ['written-by-hook'], 'afterUpdate ran anyway, with the same row');
        assert.equal((await User.orm().where('id', seeded.id).first())?.name, 'Hook', 'nothing was written');
    });

    test('a bulk update takes the count from a hook that did the work itself', async ({ assert }) => {
        await seedUser('hook-done-update');

        assert.equal(await DoneUpdateUser.orm().where('username', 'hook-done-update').updateAll({ name: 'handled-me' }), 7, 'the count the hook reported');
        assert.equal((await User.orm().where('username', 'hook-done-update').first())?.name, 'Hook', 'nothing was written');
    });

    test('a delete hook can act on the last row of the statement instead of every row', async ({ assert }) => {
        for (const username of ['hook-last-a', 'hook-last-b', 'hook-last-c']) await seedUser(username);
        LastRowDeleteUser.invalidations = [];
        LastRowDeleteUser.perRow = [];

        const deleted = await LastRowDeleteUser.orm().withTrashed().whereIn('username', ['hook-last-a', 'hook-last-b', 'hook-last-c']).delete(null);

        assert.equal(deleted, 3, 'every row went');
        assert.lengthOf(LastRowDeleteUser.perRow, 3, 'the hook ran once per row');
        assert.deepEqual(LastRowDeleteUser.invalidations, ['entries'], 'and the invalidation ran once, on the last row');
    });

    test('a refusing beforeDelete stops the whole delete before anything is written', async ({ assert }) => {
        for (const username of ['hook-refuse-a', 'hook-system']) {
            await User.orm().withTrashed().where('username', username).delete(null);
            await User.orm().upsert({ ...base, username });
        }

        await assert.rejects(() => GuardedDeleteUser.orm().withTrashed().whereIn('username', ['hook-refuse-a', 'hook-system']).delete(null), /a system user cannot be deleted/);

        // The row the hook accepted is still there: every row is read and every hook runs before the first write.
        assert.isNotNull(await User.orm().withTrashed().where('username', 'hook-refuse-a').first());
        assert.isNotNull(await User.orm().withTrashed().where('username', 'hook-system').first());
    });

    test('hooks see the transaction they run in', async ({ assert }) => {
        TxAwareUser.sawClient = [];

        await TxAwareUser.orm().first();
        await transaction((tx) => TxAwareUser.orm().withClient(tx).first());

        assert.deepEqual(TxAwareUser.sawClient, [false, true]);
    });

    test('engine hooks do not block the raw path, so a client is allowed', async ({ assert }) => {
        MirroredUser.ran = [];

        const created = await transaction((tx) => Orm.create(MirroredUser, { ...base, password: '', username: `hook-mirror-${Date.now()}` }, { client: tx }));

        // The hook ran inside the transaction.
        assert.deepEqual(MirroredUser.ran, [`engine:${created.id}`]);
    });
});

/**
 * `withoutHooks(...)`: the statement decides which hooks it runs, so an app keeps its policy (a stamp, a
 * scope, a cascade) in its own hooks and the engine never has to know a column name.
 */
test.group('withoutHooks', (group) => {
    group.setup(async () => {
        if (!SkipProbeUser.booted) SkipProbeUser.boot();
    });

    test('a skipped hook does not run, and the other hooks still do', async ({ assert }) => {
        SkipProbeUser.ran = [];
        assert.isNull(await SkipProbeUser.orm().first(), 'beforeRead narrowed the query to nothing');
        assert.deepEqual(SkipProbeUser.ran, ['beforeRead'], 'no row came back, so afterRead had nothing to shape');

        SkipProbeUser.ran = [];
        assert.isNotNull(await SkipProbeUser.orm().withoutHooks('beforeRead').first(), 'the narrowed query never happened');
        assert.deepEqual(SkipProbeUser.ran, ['afterRead'], 'only the skipped hook was left out — the row still went through afterRead');

        assert.isNull(await SkipProbeUser.orm().first(), 'a later statement keeps its hooks');
    });

    test('skipping the delete hooks asks for the single bulk statement', async ({ assert }) => {
        const username = `hook-skip-${Date.now()}`;
        // Seeded through the plain model: `Orm.create()` reads the row back, and this group's `beforeRead`
        // would hide it.
        await User.orm().upsert({ ...base, username });

        // Declared and not skipped: one statement per row, so each hook gets the row — the read a delete runs to
        // find its rows is not a read hook's business, so `beforeRead` cannot hide it either.
        SkipProbeUser.ran = [];
        assert.equal(await SkipProbeUser.orm().withTrashed().where('username', username).delete(null), 1);
        assert.deepEqual(SkipProbeUser.ran, [`beforeDelete:${username}`, `afterDelete:${username}`]);

        // Skipped: the delete goes out as the caller wrote it, in one statement, and nothing records a hook.
        await User.orm().upsert({ ...base, username });
        SkipProbeUser.ran = [];
        assert.equal(await SkipProbeUser.orm().withTrashed().where('username', username).withoutHooks('beforeDelete', 'afterDelete').delete(null), 1);
        assert.deepEqual(SkipProbeUser.ran, []);
    });

    test('several hooks can be skipped at once', async ({ assert }) => {
        SkipProbeUser.ran = [];

        // Both skipped: the read is unfiltered and nothing records it.
        assert.isNotNull(await SkipProbeUser.orm().withoutHooks('beforeRead', 'afterRead').first());
        assert.deepEqual(SkipProbeUser.ran, []);
    });

    test('the skip survives a where(), and only real hook names are accepted', ({ assert }) => {
        // Compile-time pins: the chain keeps its shape after `where(...)` (the mutate type), several names are
        // accepted, and a name that is not a hook does not compile.
        const chained = SkipProbeUser.orm().where('id', 1).withoutHooks('beforeUpdate', 'afterDelete');

        assert.isFunction(chained.updateAll);
        // @ts-expect-error 'beforeUpdat' is not a hook
        SkipProbeUser.orm().withoutHooks('beforeUpdat');
    });
});
