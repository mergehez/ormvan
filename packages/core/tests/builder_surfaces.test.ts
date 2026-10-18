import { test } from '@japa/runner';
import type { HasMany } from '../src/index.js';
import { column, hasMany } from '../src/index.js';
import { CountQueryBuilder } from '../src/orm_count_query_builder.js';
import { WhereHasQueryBuilder } from '../src/orm_simple_builder.js';
import { PreloadQueryBuilder } from '../src/orm_subquery_builder.js';
import { FakeBaseModel } from './support/fakes.js';

const { Orm } = await import('./support/executor.js');

test.group('builder surfaces', () => {
    test('each flavour is handed only the members its subtree honours', ({ assert }) => {
        class FakeEntryRating extends FakeBaseModel {
            static table = 'entry_ratings';
            @column() declare target_id: number;
            @column() declare value: number;
        }
        class FakeEntry extends FakeBaseModel {
            static table = 'entries';
            @column() declare content: string;
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id' }) declare ratings: HasMany<typeof FakeEntryRating>;
            @hasMany(() => FakeEntryRating, { foreignKey: 'target_id' }) declare ratings2: HasMany<typeof FakeEntryRating>;
        }
        const q = new Orm(FakeEntry);

        if (Date.now() < 0) {
            // @ts-expect-error — `paginating` belongs to a preload callback, not to a chain
            q.paginating(10);
            // @ts-expect-error — the count alias is `withCount`'s argument, not a chain member
            q.as('alias');
        }

        const b = q
            .withCount('ratings', (c) => {
                c.where('value', 4);
                if (Date.now() < 0) {
                    // @ts-expect-error — a count subquery only contributes WHERE
                    c.select('value');
                    // @ts-expect-error — and it cannot preload, order or paginate
                    c.preload('ratings');
                    // @ts-expect-error
                    c.orderBy('value');
                    // @ts-expect-error
                    c.paginating(10);
                    // @ts-expect-error — nor join: `orm_count.ts` reads no join clause
                    c.join(FakeEntry, 'target_id', '=', 'id');
                    // @ts-expect-error — nor run a query of its own
                    c.toSQL();
                }
                return c.as('rates');
            })
            .preload('ratings2')
            .preloadCb('ratings', (p) => {
                const q = p.where('value', 4).orderBy('value').limit(3);
                if (Date.now() < 0) {
                    // @ts-expect-error — a preload callback cannot run a query of its own
                    p.toSQL();
                    // @ts-expect-error — nor join a derived table
                    p.joinSub({ sql: '', bindings: [] }, 'x', 'id', '=', 'x.id');
                    // @ts-expect-error — nor own a second statement
                    p.union(p);
                    // @ts-expect-error — `withClient` belongs to the statement
                    p.withClient(p);
                }

                // It DOES own the joins: the preload compiler places them in its subquery and the joined model's
                // columns in the nested row — the same rule as the main projection, so a shared name stays with the
                // child. A count subquery reads only WHERE, so it has none (below).
                q.join(FakeEntry, 'target_id', '=', 'id');

                return q.paginating(5);
            })
            .whereHas('ratings', (w) => {
                w.where('value', 4);
                if (Date.now() < 0) {
                    // @ts-expect-error — a `whereHas` subquery only contributes WHERE
                    w.select('value');
                    // @ts-expect-error
                    w.preload('ratings');
                    // @ts-expect-error
                    w.withCount('ratings');
                    // @ts-expect-error — nor a join: `orm_where.ts` reads no join clause
                    w.join(FakeEntry, 'target_id', '=', 'id');
                }
            });

        // The main chain still has the projection, the joins and `toSQL`; the alias never became a chain member.
        assert.include(b.toSQL().sql, 'AS rates');

        if (Date.now() < 0) {
            // The statement-level members are on a main chain — that is the positive half of this surface: a join by
            // model (typed) or by table (raw), and a union whose member is the same chain type.
            q.select('id').join(FakeEntryRating, 'id', '=', 'target_id').leftJoinSql('topics as t2', 'users.id', '=', 't2.created_by').crossJoinSql('topics');
            q.select('id').union(q.select('id')).unionAll(q.select('id'));
            // @ts-expect-error — a union member is the same chain type, not merely the same model
            q.select('id').union(q.select('username'));

            // @ts-expect-error — the count alias is `withCount`'s argument, not a chain member
            b.as('nope');
            // @ts-expect-error — nor can a main chain paginate itself: that belongs to a preload
            b.paginating(10);
            // @ts-expect-error — the state the engines drive is protected: a chain offers queries, not wiring
            b.whereEngine;
            // @ts-expect-error
            b.limitValue;
            // @ts-expect-error
            b.client;
        }

        // ...and the one public hatch is what code outside the hierarchy uses to reach it.
        assert.isDefined(b.__internals().whereEngine);
    });

    test('each callback is handed the class its type names', ({ assert }) => {
        class ProbeRating extends FakeBaseModel {
            static table = 'probe_ratings';
            @column() declare target_id: number;
        }
        class ProbeEntry extends FakeBaseModel {
            static table = 'probe_entries';
            @column() declare content: string;
            @hasMany(() => ProbeRating, { foreignKey: 'target_id' }) declare ratings: HasMany<typeof ProbeRating>;
        }

        const seen: Record<string, boolean> = {};

        new Orm(ProbeEntry)
            .preloadCb('ratings', (p) => {
                seen.preload = p instanceof PreloadQueryBuilder;
                p.whereGrouped((grouped) => {
                    // A grouped WHERE spawns the flavour it was called on, not the app's whole chain.
                    seen.grouped = grouped instanceof PreloadQueryBuilder;
                });
            })
            .withCount('ratings', (c) => {
                seen.count = c instanceof CountQueryBuilder;
            })
            .whereHas('ratings', (w) => {
                seen.whereHas = w instanceof WhereHasQueryBuilder;
            });

        assert.isTrue(seen.preload, 'a preload callback gets a PreloadQueryBuilder');
        assert.isTrue(seen.grouped, 'a grouped WHERE gets the receiver’s own flavour');
        assert.isTrue(seen.count, 'a count callback gets a CountQueryBuilder');
        assert.isTrue(seen.whereHas, 'a whereHas callback gets a WhereHasQueryBuilder');
    });
});
