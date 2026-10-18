/**
 * Model scopes: a static declared through `scope(…)` becomes a chainable method
 * (`ScopedTopic.orm().createdBy(7)`).
 */
import { test } from '@japa/runner';
import { belongsTo, column, defaultSoftDelete, type ModelBuilder, PlainBaseModel, scope, softDeleteScopes } from '../src/index.js';
import type { BelongsTo } from '../src/orm_relations.js';

class ScopedUser extends PlainBaseModel {
    static table = 'users';

    @column() declare id: number;
    @column() declare name: string;
}

/**
 * The chain the shape-changing scope applies — written once here, so its state has a name to reuse. It does not use
 * a scope of its own model: the return type below feeds `ScopeMethods`, so a scope inside it would close the circle
 * the type has to resolve.
 */
const withCreatorChain = (b: ModelBuilder<typeof ScopedTopic>) => b.preload('creator');

class ScopedTopic extends PlainBaseModel {
    static table = 'topics';
    /** Soft-deletable, so the scopes below have a guard to lift (`withTrashed()` is one of its scopes). */
    static softDelete = defaultSoftDelete;
    static withTrashed = softDeleteScopes.withTrashed;
    static ignoreSoftDeleteGuard = softDeleteScopes.ignoreSoftDeleteGuard;
    static restore = softDeleteScopes.restore;
    static forceDelete = softDeleteScopes.forceDelete;

    @column() declare id: number;
    @column() declare title: string;
    @column() declare created_by: number;
    @column() declare deleted_at: number | null;

    @belongsTo(() => ScopedUser, { foreignKey: 'created_by' }) declare creator: BelongsTo<typeof ScopedUser>;

    /** A filter scope: chainable as `.createdBy(userId)`, and `b` is the builder it receives. */
    static createdBy = scope((b: ModelBuilder<typeof ScopedTopic>, userId: number) => b.withTrashed().where('created_by', userId));

    /**
     * A shape-changing scope: the written return type is the state it hands to the caller, so rows
     * from `orm().withCreator()` carry `creator`.
     */
    static withCreator = scope((b: ModelBuilder<typeof ScopedTopic>): ReturnType<typeof withCreatorChain> => withCreatorChain(b));
}

class UnscopedTopic extends PlainBaseModel {
    static table = 'topics';

    @column() declare id: number;
}

test.group('model scopes', (group) => {
    group.setup(() => {
        if (!ScopedTopic.booted) ScopedTopic.boot();
        if (!UnscopedTopic.booted) UnscopedTopic.boot();
    });

    test('a scope static becomes a chainable builder method', ({ assert }) => {
        const { sql, bindings } = ScopedTopic.orm().createdBy(7).toSQL();

        assert.include(sql, 'created_by = ?');
        assert.deepEqual(bindings, [7]);
    });

    test('a scope keeps the clauses that came before it', ({ assert }) => {
        const { sql } = ScopedTopic.orm().where('title', 'x').createdBy(7).toSQL();

        assert.include(sql, 'title = ?');
        assert.include(sql, 'created_by = ?');
    });

    test('a scope keeps the state that came before it', ({ assert }) => {
        const q = ScopedTopic.orm().withCreator().createdBy(7);

        assert.include(q.toSQL().sql, 'created_by = ?');
        assert.isFunction(q.first);
    });

    test('scopes are per model — a model without them gets none', ({ assert }) => {
        assert.notProperty(UnscopedTopic.orm(), 'createdBy');
    });
});

/**
 * Compile-only: a scope's delta has to reach the caller's row type. If `ScopeMethods` stops merging
 * the scope's own state, `creator` disappears from this row and the file fails to type-check.
 */
export async function scopeDeltaReachesTheRow() {
    const row = await ScopedTopic.orm().withCreator().createdBy(7).first();

    return row?.creator.name;
}
