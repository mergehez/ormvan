/**
 * The `database` session store, on the engine's connection: expiry is the `expires_at` column, an expired row is
 * deleted on read, a write upserts on the primary key, and garbage collection runs on a write.
 *
 * Imported as `@mergehez/ormvan-adonisjs/orm_session`, so an app that does not use Adonis' session does not need
 * `@adonisjs/session` installed to type-check the engine.
 */
import type { SessionConfig, SessionData, SessionStoreFactory, SessionStoreWithTaggingContract, TaggedSession } from '@adonisjs/session/types';
import type { OrmQueryable } from '@mergehez/ormvan';
import { deleteSql, insertSql, limitOffset, onDuplicateKeyUpdate, quoteId, quoteIds, updateSql } from '@mergehez/ormvan/orm_sql';
import './context.ts';
import { parseSeconds } from './duration.ts';

export interface OrmSessionStoreOptions {
    /**
     * The connection the statements run on — the app's executor, `() => Orm.getExecutor()`. A function, because the
     * store is built when the session manager first resolves it.
     */
    queryable: () => OrmQueryable;
    /** How long a session lives: seconds, or a time expression (`'2 hours'`). */
    age: string | number;
    /** Defaults to `'sessions'`. */
    table?: string;
    /** Percent chance that a write also deletes expired rows. Defaults to 2; `0` disables it. */
    gcProbability?: number;
}

export class OrmSessionStore implements SessionStoreWithTaggingContract {
    readonly #db: OrmQueryable;
    readonly #table: string;
    readonly #ttlSeconds: number;
    readonly #gcProbability: number;

    constructor(options: OrmSessionStoreOptions) {
        this.#db = options.queryable();
        this.#table = options.table ?? 'sessions';
        this.#ttlSeconds = parseSeconds(options.age);
        this.#gcProbability = options.gcProbability ?? 2;
    }

    /** The row's `data` as the values it was written from — `null` for a message that does not verify. */
    async read(sessionId: string): Promise<SessionData | null> {
        const rows = await this.#db.query(`SELECT ${quoteIds(['data', 'expires_at'])} FROM ${quoteId(this.#table)} WHERE ${quoteId('id')} = ?${limitOffset(1)}`, [sessionId]);
        const row = rows[0];

        if (!row) return null;

        // The column is the clock, not the message: a row past its expiry is deleted here and reads as no session.
        if (Date.now() > timeOf(row.expires_at)) {
            await this.destroy(sessionId);
            return null;
        }

        return parseSessionData(row.data, sessionId);
    }

    async write(sessionId: string, data: SessionData): Promise<void> {
        const message = encodeSessionData(data, sessionId);
        const expiresAt = this.#expiresAt();

        // `ON DUPLICATE KEY UPDATE` repeats each value, so one statement covers insert and update both.
        await this.#db.exec(insertSql(this.#table, ['id', 'data', 'expires_at'], false) + onDuplicateKeyUpdate(['data', 'expires_at']), [
            sessionId,
            message,
            expiresAt,
            message,
            expiresAt,
        ]);

        await this.#collectGarbage();
    }

    async destroy(sessionId: string): Promise<void> {
        await this.#db.exec(`${deleteSql(this.#table)} WHERE ${quoteId('id')} = ?`, [sessionId]);
    }

    async touch(sessionId: string): Promise<void> {
        await this.#db.exec(updateSql(this.#table, ['expires_at'], 'id'), [this.#expiresAt(), sessionId]);
    }

    /**
     * Tags a session with a user id. Insert-and-merge like `write`, but only `user_id` is merged: the row keeps
     * whatever `data` it has, and a row that is not there yet gets an empty session the request will write into.
     */
    async tag(sessionId: string, userId: string | number): Promise<void> {
        const message = encodeSessionData({}, sessionId);
        const expiresAt = this.#expiresAt();
        const id = String(userId);

        await this.#db.exec(insertSql(this.#table, ['id', 'user_id', 'data', 'expires_at'], false) + onDuplicateKeyUpdate(['user_id']), [sessionId, id, message, expiresAt, id]);
    }

    /**
     * Untags a session. The session id is the whole association, so the user id the contract passes along is
     * not needed here — hence the method's shorter parameter list.
     */
    async untag(sessionId: string): Promise<void> {
        await this.#db.exec(updateSql(this.#table, ['user_id'], 'id'), [null, sessionId]);
    }

    /** The sessions a user is tagged in, still unexpired — one row per device, decoded. */
    async tagged(userId: string | number): Promise<TaggedSession[]> {
        const rows = await this.#db.query(`SELECT ${quoteIds(['id', 'data'])} FROM ${quoteId(this.#table)} WHERE ${quoteId('user_id')} = ? AND ${quoteId('expires_at')} > ?`, [
            String(userId),
            new Date(),
        ]);
        const sessions: TaggedSession[] = [];

        for (const row of rows) {
            const data = parseSessionData(row.data, String(row.id));

            // A row that does not verify is skipped rather than returned as a half-session.
            if (data) sessions.push({ id: String(row.id), data });
        }

        return sessions;
    }

    #expiresAt(): Date {
        return new Date(Date.now() + this.#ttlSeconds * 1000);
    }

    /** Deletes the rows nobody can use any more, on the fraction of writes the config asks for. */
    async #collectGarbage(): Promise<void> {
        if (this.#gcProbability <= 0) return;
        if (Math.random() * 100 >= this.#gcProbability) return;

        await this.#db.exec(`${deleteSql(this.#table)} WHERE ${quoteId('expires_at')} <= ?`, [new Date()]);
    }
}

/**
 * The `database` store for a session config — `stores: { database: ormSessionStore({ queryable: () => Orm.getExecutor() }) }`.
 *
 * The age is the session config's (`sessionConfig.age`) unless the app states one.
 */
export function ormSessionStore(options: Omit<OrmSessionStoreOptions, 'age'> & { age?: string | number }): SessionStoreFactory {
    return (_, sessionConfig: SessionConfig) => new OrmSessionStore({ ...options, age: options.age ?? sessionConfig.age });
}

/**
 * A session payload as the row's `data`: the session id is the purpose, so a row cannot be replayed as another
 * session. The same JSON `@poppinss/utils`' `MessageBuilder` writes, so existing rows keep reading.
 */
export function encodeSessionData(data: SessionData, sessionId: string): string {
    return JSON.stringify({ message: data, purpose: sessionId });
}

/** A session row's `data` back as values — `null` for anything that does not verify. */
function parseSessionData(contents: unknown, sessionId: string): SessionData | null {
    if (typeof contents !== 'string') return null;

    try {
        const parsed = JSON.parse(contents);
        if (typeof parsed !== 'object' || !parsed?.message) return null;

        return parsed.purpose === sessionId ? (parsed.message as SessionData) : null;
    } catch {
        return null;
    }
}

/** A timestamp column as a number, whatever the driver handed back (mysql2 answers with a `Date`). */
function timeOf(value: unknown): number {
    return value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
}
