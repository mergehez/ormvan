/**
 * Select aliases: literal forms must stay bare in the SQL, and the row type follows the literal — `number` for
 * `'1 as n'`, `boolean` for `'true as is_x'`, the column's own type for `'id as target_id'`.
 *
 * MySQL has no boolean type, so a `boolean` alias arrives as 1/0.
 */
import { test } from '@japa/runner';
import { dbRaw } from '../src/index.js';
import { User } from './support/models.js';

// Compile-time assertions, checked by `tsc` rather than at runtime.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Row<F extends () => unknown> = NonNullable<Awaited<ReturnType<F>>>;

function _booleanAliases() {
    return User.orm().select('true as is_active', 'false as is_deleted').first();
}
function _numericAlias() {
    return User.orm().select('1 as answers_count').first();
}
function _columnAliases() {
    return User.orm().select('id as target_id', 'name as who').first();
}

/**
 * `dbRaw(...)` must be usable as a select item. This function exists so `tsc` checks it; nothing calls it.
 */
function _rawExpressionSelectItem() {
    return User.orm()
        .select(dbRaw('ROUND(SUM(id) / ?)', [1]))
        .first();
}

export type TrueAliasIsBoolean = Expect<Equal<Row<typeof _booleanAliases>['is_active'], boolean>>;
export type FalseAliasIsBoolean = Expect<Equal<Row<typeof _booleanAliases>['is_deleted'], boolean>>;
export type NumericAliasIsNumber = Expect<Equal<Row<typeof _numericAlias>['answers_count'], number>>;
export type IdAliasKeepsColumnType = Expect<Equal<Row<typeof _columnAliases>['target_id'], number>>;
export type NameAliasKeepsColumnType = Expect<Equal<Row<typeof _columnAliases>['who'], string>>;

test.group('orm select aliases', () => {
    test('a raw expression select item carries its bindings', ({ assert }) => {
        const { sql, bindings } = User.orm()
            .select(dbRaw('ROUND(SUM(id) / ?)', [2]))
            .where('id', 1)
            .toSQL();

        assert.include(sql, 'ROUND(SUM(id) / ?)');
        assert.deepEqual(bindings, [2, 1]);
    });

    test('a boolean literal alias is not qualified with the table name', ({ assert }) => {
        const { sql } = User.orm().select('true as is_active').where('id', 1).toSQL();
        assert.include(sql, 'true AS is_active');
        assert.notInclude(sql, '.true');
    });

    test('TRUE / FALSE are literals whatever their case', ({ assert }) => {
        const { sql } = User.orm().select('FALSE as is_deleted', 'True as is_active').where('id', 1).toSQL();
        assert.include(sql, 'FALSE AS is_deleted');
        assert.include(sql, 'True AS is_active');
        assert.notInclude(sql, '.FALSE');
        assert.notInclude(sql, '.True');
    });

    test('a numeric literal alias stays bare', ({ assert }) => {
        const { sql } = User.orm().select('1 as answers_count').where('id', 1).toSQL();
        assert.include(sql, '1 AS answers_count');
        assert.notInclude(sql, '.1');
    });

    test('a column alias is still qualified', ({ assert }) => {
        const { sql } = User.orm().select('id as target_id').where('id', 1).toSQL();
        assert.include(sql, 'users.id AS target_id');
    });
});
