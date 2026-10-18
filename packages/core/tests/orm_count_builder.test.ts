import { test } from '@japa/runner';
import type { HasMany } from '../src/index.js';
import { column, hasMany } from '../src/index.js';
import type { CountQuery } from '../src/orm_builder.js';
import { FakeBaseModel, stubRawQuery } from './support/fakes.js';

const { Orm } = await import('./support/executor.js');

test.group('count builder', (group) => {
    group.setup(() => stubRawQuery(() => [[{ total: 42 }], []]));

    test('a count callback is typed to the child model', async ({ assert, expectTypeOf }) => {
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

        const b = new Orm(FakeEntry).where('status', 1).withCount('ratings', (r) => {
            expectTypeOf(r).toEqualTypeOf<CountQuery<typeof FakeEntry, 'ratings'>>();
            r.where('value', 4);
            if (Date.now() < 0) {
                // @ts-expect-error — not a column of the child model
                r.where('nope', 4);
            }
            return r.as('rates');
        });

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        assert.include(sql, 'entry_ratings.value = ?');
        assert.match(sql, /AS rates/);
        // The count subquery's bindings come from the SELECT list, before the where's.
        assert.deepEqual(bindings, [4, 1]);

        const rows = await b.get();
        expectTypeOf(rows).items.toHaveProperty('rates');
        expectTypeOf(rows[0].rates).toEqualTypeOf<number>();
        assert.equal(rows.length, 1); // mock returns a single row
    });

    test('a callback alias defaults to `<relation>_count`', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModel {
            static table = 'entry_ratings';
            @column() declare target_id: number;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare status: number;
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id' }) declare ratings: HasMany<typeof FakeEntryRating>;
        }

        // Chains and returns the builder: no alias string, so the default name is used.
        const b = new Orm(FakeEntry).withCount('ratings', (r) => r.whereNotNull('target_id'));

        const { sql } = b.toSQL();
        console.log(`\nSQL:\n${sql}`);
        assert.match(sql, /AS ratings_count/);
        assert.include(sql, 'entry_ratings.target_id IS NOT NULL');
    });

    test('a callback `orWhere` is parenthesized so the OR cannot escape the correlation', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModel {
            static table = 'entry_ratings';
            @column() declare target_id: number;
            @column() declare value: number;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id' }) declare ratings: HasMany<typeof FakeEntryRating>;
        }

        const b = new Orm(FakeEntry).withCount('ratings', (r) => r.where('value', 4).orWhere('value', 5).as('rates'));

        const { sql, bindings } = b.toSQL();
        console.log(`\nSQL:\n${sql}\nbindings:`, bindings);

        // Without the parens the OR would match every row with `value = 5`.
        assert.include(sql, 'AND (entry_ratings.value = ? OR entry_ratings.value = ?)');
        assert.deepEqual(bindings, [4, 5]);
    });

    test('a count callback filters on a table-qualified column', ({ assert }) => {
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare topic_id: number;
            @column() declare status: number;
        }
        class FakeTopic extends FakeBaseModel {
            static table = 'topics';
            @hasMany(() => FakeEntry, { foreignKey: 'topic_id' }) declare entries: HasMany<typeof FakeEntry>;
        }

        const b = new Orm(FakeTopic).withCount('entries', (c) => c.where('entries.status', 1).as('live_count'));

        const { sql } = b.toSQL();
        assert.include(sql, 'entries.status = ?');
        assert.match(sql, /AS live_count/);
    });
});
