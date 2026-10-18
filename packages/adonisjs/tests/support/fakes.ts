/**
 * Test-only scaffolding shared by the adapter's specs: helpers that swap the executor out and answer every statement
 * with a handler.
 */
import type { OrmExecutor, OrmQueryable } from '@mergehez/ormvan';
import { currentExecutor, Orm, useExecutor } from './executor.js';

export type RawQueryHandler = (sql: string, bindings: unknown[]) => unknown;

/** Rows out of whatever a handler returned — mysql2's `[rows, fields]` pair, or a bare `{ rows }`/array. */
function rowsOf(raw: unknown): Record<string, unknown>[] {
    const rows = Array.isArray(raw) ? raw[0] : (raw as { rows?: unknown } | null)?.rows;

    return (rows ?? []) as Record<string, unknown>[];
}

/**
 * Answers every statement the specs run with `handler` for the duration of a group, and returns a function that
 * restores the previous executor (usable as a Japa cleanup). Transactions are left to the real executor.
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
