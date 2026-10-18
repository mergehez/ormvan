/**
 * The engine's own model declarations (`@column` from `src/orm_model.ts`): what `modelMeta` reads off a model, and
 * that a query built from such a model runs.
 */
import { test } from '@japa/runner';
import { column, defaultSoftDelete, jsonDec, modelMeta, PlainBaseModel } from '../src/index.js';
import { Orm } from './support/executor.js';
import { rawRows } from './support/fakes.js';

/** A base class declaring columns through the engine's own decorator — the hosts' audit bases. */
class EngineBase extends PlainBaseModel {
    @column() declare created_at: number;
    @column() declare created_by: number;
}

class EngineTopic extends EngineBase {
    static table = 'topics';

    /** The opt-in: a soft delete is CONFIGURED, never inferred from a column name. */
    static softDelete = defaultSoftDelete;

    @column({ isPrimary: true }) declare id: number;
    @column() declare title: string;
    @column() declare status: number;
    // A property whose name differs from its column, plus a cast — the two option kinds the apps use.
    @column({ columnName: 'mentions', ...jsonDec }) declare mentionsJson: string[] | null;
    @column() declare deleted_at: number | null;
}

/** Declares `deleted_at` but asks for nothing: the column alone must not turn a scope on. */
class EngineTopicWithoutConfig extends EngineBase {
    static table = 'topics';

    @column({ isPrimary: true }) declare id: number;
    @column() declare deleted_at: number | null;
}

/** A model whose primary key is not `id` (the hosts' `cache` shape) — proves `isPrimary` is what counts. */
class EngineCache extends EngineBase {
    static table = 'cache';

    @column({ isPrimary: true }) declare key: string;
    @column() declare value: string;
}

test.group('engine model declarations', () => {
    test('modelMeta reads the columns a model declares with @column, base classes first', ({ assert }) => {
        const meta = modelMeta(EngineTopic);

        assert.deepEqual(meta.columns, ['created_at', 'created_by', 'id', 'title', 'status', 'mentionsJson', 'deleted_at']);
    });

    test('columnNames carries a columnName override and castPrepare carries a cast', ({ assert }) => {
        const meta = modelMeta(EngineTopic);

        assert.equal(meta.columnNames.get('mentionsJson'), 'mentions');
        assert.equal(meta.columnNames.get('title'), 'title');
        const prepare = meta.castPrepare.get('mentionsJson');
        assert.isFunction(prepare);
        assert.equal(prepare!(['a', 'b'], 'mentionsJson'), '["a","b"]');
    });

    test('a column marked isPrimary becomes the model primary key, whatever it is called', ({ assert }) => {
        assert.equal(modelMeta(EngineTopic).primaryKey, 'id');
        assert.equal(modelMeta(EngineCache).primaryKey, 'key');
    });

    test('soft delete is configured, not inferred from a `deleted_at` column', ({ assert }) => {
        // The config is the whole opt-in: the same column with no config asks for no scope.
        assert.isTrue(modelMeta(EngineTopic).isSoftDeletable);
        assert.deepEqual(modelMeta(EngineTopic).softDelete, defaultSoftDelete);
        assert.isFalse(modelMeta(EngineCache).isSoftDeletable);
        assert.isUndefined(modelMeta(EngineCache).softDelete);
        assert.isFalse(modelMeta(EngineTopicWithoutConfig).isSoftDeletable);
        assert.notMatch(new Orm(EngineTopicWithoutConfig).toSQL().sql, /deleted_at is null/i);
    });

    test('a config naming a column the model does not declare is refused loudly', ({ assert }) => {
        class Mistyped extends EngineBase {
            static table = 'topics';

            static softDelete = { column: 'remove_at' };

            @column({ isPrimary: true }) declare id: number;
            @column() declare deleted_at: number | null;
        }

        assert.throws(() => modelMeta(Mistyped), /Soft delete misconfigured on model 'Mistyped': column 'remove_at' is not one of its columns/);
    });

    test('SQL built from engine-declared columns runs: the soft-delete scope is applied', async ({ assert }) => {
        const sql = new Orm(EngineTopic).toSQL().sql;
        assert.match(sql, /from `?topics`?/i);
        assert.match(sql, /deleted_at is null/i);

        const row = await EngineTopic.orm().where('id', 0).first();
        assert.isNull(row);
    });

    test('a preload fallback is valid MySQL: IFNULL over a JSON row, with the substitute CAST', async ({ assert }) => {
        // The runtime half of `tests/orm_sql.test.ts`'s fallback spec: the expression the compiler emits has to
        // run, and the substitute has to come back as the object it states.
        const [row] = await rawRows<{ v: unknown }>(`SELECT IFNULL((SELECT JSON_OBJECT('id', id) FROM topics WHERE id = -1), CAST(? AS JSON)) AS v`, [
            '{"id":-1,"username":"user-not-found"}',
        ]);

        const value = typeof row.v === 'string' ? JSON.parse(row.v) : row.v;
        assert.deepEqual(value, { id: -1, username: 'user-not-found' });
    });
});
