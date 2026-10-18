/**
 * Test-only scaffolding shared by the engine's specs: the executor the specs install, and helpers that swap it out.
 */
import { Assert } from '@japa/assert';
import { column, PlainBaseModel, SoftDeletes, type OrmExecutor, type OrmQueryable } from '../../src/index.js';
import { currentExecutor, Orm, useExecutor } from './executor.js';

export type RawQueryHandler = (sql: string, bindings: unknown[]) => unknown;

/** Rows out of whatever a handler returned — mysql2's `[rows, fields]` pair, or a bare `{ rows }`/array. */
function rowsOf(raw: unknown): Record<string, unknown>[] {
    const rows = Array.isArray(raw) ? raw[0] : (raw as { rows?: unknown } | null)?.rows;

    return (rows ?? []) as Record<string, unknown>[];
}

/**
 * Asserts that `fn` throws and that its message matches `matcher`.
 * (`@japa/assert`'s contract omits chai's `assert.throws`, so this uses the instance methods.)
 */
export function assertThrows(assert: Assert, fn: () => unknown, matcher: RegExp | string): void {
    try {
        fn();
    } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error);
        if (matcher instanceof RegExp) {
            assert.match(message, matcher);
        } else {
            assert.include(message, matcher);
        }
        return;
    }
    assert.fail('Expected function to throw');
}

/**
 * Answers every statement the specs' models run with `handler` for the duration of a group, and returns a function
 * that restores the previous executor (usable as a Japa cleanup). Transactions are left to the real executor.
 */
export function stubRawQuery(handler: RawQueryHandler): () => void {
    const original = currentExecutor();

    const stubbed: OrmExecutor = {
        async query(sql, bindings) {
            return rowsOf(await handler(sql, [...bindings]));
        },
        async exec(sql, bindings) {
            return handler(sql, [...bindings]);
        },
        transaction<T>(fn: (tx: OrmQueryable) => Promise<T>): Promise<T> {
            return Orm.getExecutor().transaction(fn);
        },
    };

    useExecutor(stubbed);

    return () => useExecutor(original);
}

/** Rows of a raw query (mysql2 answers `[rows, fields]`). */
export async function rawRows<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, bindings: unknown[] = []): Promise<Row[]> {
    return Orm.runQuery<Row>(sql, bindings);
}

/** Base for the class-based fake models: an `id` keyed table, nothing else. */
export class FakeBaseModel extends PlainBaseModel {
    @column() declare id: number;
}

/**
 * A fake model with a soft delete, for the SQL-text specs: `deleted_at` is declared under a `columnName`, which
 * is exactly the mapping the engine has to honour. Config-only opt-in plus the scopes by hand — the apps write the
 * same thing as `extends SoftDeletes(Base)`.
 */
export class FakeBaseModelSoft extends SoftDeletes(FakeBaseModel) {
    @column({ columnName: 'deleted_at' }) declare deleted_at: string | null;
}
