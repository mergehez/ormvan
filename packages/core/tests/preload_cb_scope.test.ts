/**
 * A model scope whose chain builds its preloads with `preloadCb`.
 *
 * `preloadCb`'s callback receiver used to be spelled out in the signature (`(q: RelationBuilder<X, K>) => …`).
 * Resolving that builder type while the enclosing scope's own return type is being inferred is circular, so TS gave
 * up with "TS7024: Function implicitly has return type 'any' …" on the scope — which silently turned the scope, and
 * every caller's row, into `any`. The receiver is a defaulted type parameter (`Recv`) now, so scopes like
 * `scope((b) => b.preloadCb('challenger', (q) => q.withTrashed()))` infer.
 *
 * The scopes below therefore carry **no return annotation** on purpose: annotating the return type is the
 * workaround this file exists to stop needing (see `withCreator` in `scopes.test.ts`). `preloadCbMaybe` rides along
 * because it takes the same receiver.
 */
import { test } from '@japa/runner';
import { belongsTo, column, defaultSoftDelete, hasMany, type ModelBuilder, PlainBaseModel, scope, softDeleteScopes, OrmBuilderRow, OrmRow } from '../src/index.js';
import type { BelongsTo, HasMany } from '../src/orm_relations.js';

/** The SQL a chain compiles to, so a spec can say which preloads it carries. */
const sqlOf = (chain: { toSQL(): { sql: string } }) => chain.toSQL().sql;

/** Soft-deletable, so a preload callback has a guard to lift (`q.withTrashed()`), plus a hidden column. */
class CbUser extends PlainBaseModel {
    static table = 'users';
    static softDelete = defaultSoftDelete;
    static withTrashed = softDeleteScopes.withTrashed;
    static readonly hiddenColumns = ['password'] as const;

    @column() declare id: number;
    @column() declare name: string;
    @column() declare password: string;
    @column() declare deleted_at: number | null;
}

class CbMessage extends PlainBaseModel {
    static table = 'messages';

    @column() declare id: number;
    @column() declare game_id: number;
    @column() declare read_at: number | null;
}

class CbGame extends PlainBaseModel {
    static table = 'games';
    static softDelete = defaultSoftDelete;
    static withTrashed = softDeleteScopes.withTrashed;

    @column() declare id: number;
    @column() declare challenger_id: number;
    @column() declare opponent_id: number;
    @column() declare deleted_at: number | null;

    @belongsTo(() => CbUser, { foreignKey: 'challenger_id' }) declare challenger: BelongsTo<typeof CbUser>;
    @belongsTo(() => CbUser, { foreignKey: 'opponent_id' }) declare opponent: BelongsTo<typeof CbUser>;
    @hasMany(() => CbMessage, { foreignKey: 'game_id' }) declare messages: HasMany<typeof CbMessage>;

    /** The shape that broke: one `preloadCb` with a chaining callback, inside a scope, return type inferred. */
    static withChallenger = scope((b: ModelBuilder<typeof CbGame>) => b.preloadCb('challenger', (q) => q.withTrashed()));

    /** The shape a host app hit: two callback preloads, a projected one, and a conditional count. */
    static withEverything = scope((b: ModelBuilder<typeof CbGame>, authId?: number) =>
        b
            .withTrashed()
            .preload('messages', ['id', 'read_at'])
            .preloadCb('challenger', (q) => q.withTrashed())
            .preloadCb('opponent', (q) => q.withTrashed())
            .if(authId, (q) => q.withCount('messages', (m) => m.whereNull('read_at')))
    );

    /** `preloadCbMaybe` takes the same deferred receiver. */
    static withMaybeOpponent = scope((b: ModelBuilder<typeof CbGame>) => b.preloadCbMaybe('opponent', (q) => q.withTrashed()));
}

test.group('a scope that builds preloads with preloadCb', (group) => {
    group.setup(() => {
        for (const model of [CbUser, CbMessage, CbGame]) {
            if (!model.booted) model.boot();
        }
    });

    test('the callback preload reaches the compiled SQL', ({ assert }) => {
        const sql = sqlOf(CbGame.orm().withChallenger());

        assert.include(sql, 'AS challenger');
    });

    test('a scope keeps every preload — projected, callback and count — plus the clauses behind it', ({ assert }) => {
        const sql = sqlOf(CbGame.orm().withEverything(7).where('id', 1));

        assert.include(sql, 'AS challenger');
        assert.include(sql, 'AS opponent');
        assert.include(sql, 'AS messages');
        assert.include(sql, 'messages_count');
        assert.include(sql, 'id = ?');
    });

    test("the callback's clause is applied to the preload it was handed", ({ assert }) => {
        const guarded = sqlOf(CbGame.orm().preloadCb('challenger', (q) => q));
        const lifted = sqlOf(CbGame.orm().preloadCb('challenger', (q) => q.withTrashed()));

        // `withTrashed()` lifts the guard on the preloaded user, not on the outer games query.
        assert.notInclude(lifted, 'users.deleted_at IS NULL');
        assert.include(guarded, 'users.deleted_at IS NULL');
        assert.include(lifted, 'games.deleted_at IS NULL');
    });

    test('preloadCbMaybe compiles through a scope too', ({ assert }) => {
        const sql = sqlOf(CbGame.orm().withMaybeOpponent());

        assert.include(sql, 'AS opponent');
    });

    test('the inferred row carries the preloads the scope declares', ({ expectTypeOf }) => {
        const single = CbGame.orm().withChallenger();
        const everything = CbGame.orm().withEverything(1);
        const maybe = CbGame.orm().withMaybeOpponent();

        expectTypeOf<OrmBuilderRow<typeof single>>().toExtend<{ challenger: OrmRow<typeof CbUser> }>();
        expectTypeOf<OrmBuilderRow<typeof everything>>().toExtend<{
            challenger: OrmRow<typeof CbUser>;
            opponent: OrmRow<typeof CbUser>;
            messages_count: number;
        }>();
        expectTypeOf<OrmBuilderRow<typeof maybe>>().toExtend<{ opponent: OrmRow<typeof CbUser> | null }>();
    });
});

/**
 * Compile-only, like `scopeDeltaReachesTheRow` in `scopes.test.ts`.
 *
 * If `preloadCb`'s receiver stops being deferred, the scopes above fail to infer (TS7024) and this file does not
 * type-check. If instead they infer as `any`, the `@ts-expect-error` below is unused and TS reports that too — so a
 * row that keeps its preloads, and drops hidden columns, is what this pins down.
 */
export async function preloadCbScopeRowsStayConcrete() {
    const row = await CbGame.orm().withEverything(1).first();
    if (!row) return undefined;

    const name: string = row.challenger.name;
    const opponent: string = row.opponent.name;
    const count: number = row.messages_count;
    // @ts-expect-error — a hidden column is not part of a preloaded row
    const leaked = row.challenger.password;

    return { name, opponent, count, leaked };
}
