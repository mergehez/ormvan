/**
 * The `exists` / `unique` VineJS rules the engine provides, pinned on three counts: the statement, the verdict
 * through a real compiled schema, and the rule names / message templates users see.
 */
import { test } from '@japa/runner';
import vine, { ValidationError } from '@vinejs/vine';
import { dbRaw } from '../src/index.js';
import { defineOrmValidationRules } from '../src/orm_vine.js';
import { Orm } from './support/executor.js';
import { stubRawQuery } from './support/fakes.js';

interface Statement {
    sql: string;
    bindings: unknown[];
}

/** The table the expectations below name. */
const TABLE = 'users';

/** Registers the rules against the specs' executor — the thunk is what lets `stubRawQuery` swap it per test. */
const registered = () => defineOrmValidationRules(() => Orm.getExecutor());

/** A validator's failure, narrowed — these assertions are about its content, not its existence. */
function failureOf<Result>(outcome: Result | ValidationError): ValidationError {
    if (!(outcome instanceof ValidationError)) throw new Error(`Expected a validation failure, got ${JSON.stringify(outcome)}`);

    return outcome;
}

/**
 * Runs `fn` with every statement answered by `rows`, and hands back what was asked.
 */
async function withRows<Result>(rows: Record<string, unknown>[], fn: () => Promise<Result>): Promise<{ statements: Statement[]; outcome: Result | ValidationError }> {
    const statements: Statement[] = [];
    const restore = stubRawQuery((sql, bindings) => {
        statements.push({ sql, bindings });
        return [rows];
    });

    const settle = async (): Promise<Result | ValidationError> => {
        try {
            return await fn();
        } catch (error) {
            if (error instanceof ValidationError) return error;

            throw error;
        }
    };

    return { statements, outcome: await settle().finally(restore) };
}

test.group('orm vine rules — the statement', (group) => {
    group.setup(registered);

    test('exists searches the table and column the options name, one row deep', async ({ assert }) => {
        const validator = vine.create(vine.object({ created_by: vine.number().exists({ table: TABLE, column: 'id' }) }));
        const { statements } = await withRows([{ 1: 1 }], () => validator.validate({ created_by: 5 }));

        assert.deepEqual(statements, [{ sql: 'SELECT 1 FROM `users` WHERE `id` = ? LIMIT 1', bindings: [5] }]);
    });

    test('the column defaults to the field name, so a `title` field searches `title`', async ({ assert }) => {
        const validator = vine.create(vine.object({ title: vine.string().unique({ table: 'topics' }) }));
        const { statements } = await withRows([], () => validator.validate({ title: 'hi' }));

        assert.deepEqual(statements, [{ sql: 'SELECT 1 FROM `topics` WHERE `title` = ? LIMIT 1', bindings: ['hi'] }]);
    });

    test('a filter fragment is ANDed after the value, in one binding list', async ({ assert }) => {
        const validator = vine.create(
            vine.object({
                title: vine.string().unique({
                    table: 'topics',
                    column: 'title',
                    // The shape `updateTopicValidator` is after: the row being edited does not count.
                    filter: (_, field) => dbRaw('`id` <> ?', [field.meta?.params?.id]),
                }),
            })
        );
        const { statements } = await withRows([], () => validator.validate({ title: 'mine' }, { meta: { params: { id: 42 } } }));

        assert.deepEqual(statements, [{ sql: 'SELECT 1 FROM `topics` WHERE `title` = ? AND (`id` <> ?) LIMIT 1', bindings: ['mine', 42] }]);
    });

    test('a filter that returns nothing leaves the statement alone', async ({ assert }) => {
        const validator = vine.create(vine.object({ title: vine.string().unique({ table: 'topics', filter: () => undefined }) }));
        const { statements } = await withRows([], () => validator.validate({ title: 'hi' }));

        assert.deepEqual(statements, [{ sql: 'SELECT 1 FROM `topics` WHERE `title` = ? LIMIT 1', bindings: ['hi'] }]);
    });
});

test.group('orm vine rules — the verdict', (group) => {
    group.setup(registered);

    test('exists passes when the row is there and fails when it is not', async ({ assert }) => {
        const validator = vine.create(vine.object({ created_by: vine.number().exists({ table: TABLE, column: 'id' }) }));

        const found = await withRows([{ 1: 1 }], () => validator.validate({ created_by: 5 }));
        assert.deepEqual(found.outcome, { created_by: 5 });

        const missing = failureOf((await withRows([], () => validator.validate({ created_by: 5 }))).outcome);

        assert.equal(missing.messages[0].message, 'The selected created_by is invalid');
        assert.equal(missing.messages[0].rule, 'database.exists');
    });

    test('unique passes when the row is absent and fails when it is there', async ({ assert }) => {
        const validator = vine.create(vine.object({ title: vine.string().unique({ table: 'topics', column: 'title' }) }));

        const free = await withRows([], () => validator.validate({ title: 'hi' }));
        assert.deepEqual(free.outcome, { title: 'hi' });

        const taken = failureOf((await withRows([{ 1: 1 }], () => validator.validate({ title: 'hi' }))).outcome);

        assert.equal(taken.messages[0].message, 'The title has already been taken');
        assert.equal(taken.messages[0].rule, 'database.unique');
    });

    test('a field another rule already rejected is not searched for', async ({ assert }) => {
        const validator = vine.create(vine.object({ title: vine.string().minLength(10).unique({ table: 'topics' }) }));
        const { statements, outcome } = await withRows([{ 1: 1 }], () => validator.validate({ title: 'short' }));

        // A message about a value that was rejected anyway helps nobody, so no statement runs at all.
        assert.equal(failureOf(outcome).messages[0].rule, 'minLength');
        assert.lengthOf(statements, 0);
    });

    test('registering twice is harmless — a provider can boot twice in one process', async ({ assert }) => {
        // The macros live on the shared VineJS classes, so this only asserts that the second call is quiet.
        assert.doesNotThrow(() => registered());
        assert.isFunction(vine.number().exists);
        assert.isFunction(vine.string().unique);
    });
});
