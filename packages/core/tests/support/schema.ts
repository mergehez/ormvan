/**
 * The engine's tests run against their own scratch database (`DB_DATABASE`, default `orm_test`), created on demand.
 * Tables mirror the example models in `models.ts`.
 */
import mysql, { type Pool } from 'mysql2/promise';
import { dbConfig } from './env.js';

const TABLES: Record<string, string> = {
    users: `CREATE TABLE users (
        id int unsigned NOT NULL AUTO_INCREMENT,
        username varchar(191) NOT NULL,
        name varchar(191) NOT NULL,
        email varchar(191) NOT NULL,
        avatar varchar(191) NULL,
        last_seen_at bigint NULL,
        password varchar(191) NOT NULL DEFAULT '',
        password_sha varchar(191) NULL,
        remember_token varchar(191) NULL,
        created_at bigint NOT NULL DEFAULT 0,
        created_by int NOT NULL DEFAULT 0,
        updated_at bigint NOT NULL DEFAULT 0,
        updated_by int NULL,
        deleted_at bigint NULL,
        deleted_by int NULL,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    topics: `CREATE TABLE topics (
        id int unsigned NOT NULL AUTO_INCREMENT,
        title varchar(191) NOT NULL,
        status int NOT NULL DEFAULT 0,
        mentions varchar(191) NULL,
        created_at bigint NOT NULL DEFAULT 0,
        created_by int NOT NULL DEFAULT 0,
        updated_at bigint NOT NULL DEFAULT 0,
        updated_by int NULL,
        deleted_at bigint NULL,
        deleted_by int NULL,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    chat_messages: `CREATE TABLE chat_messages (
        id int unsigned NOT NULL AUTO_INCREMENT,
        content text NOT NULL,
        receiver_id int NOT NULL,
        read_at bigint NULL,
        created_at bigint NOT NULL DEFAULT 0,
        created_by int NOT NULL DEFAULT 0,
        deleted_at bigint NULL,
        deleted_by int NULL,
        PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    cache: `CREATE TABLE cache (
        \`key\` varchar(191) NOT NULL,
        value mediumtext NULL,
        expiration int NOT NULL DEFAULT 0,
        type tinyint NOT NULL DEFAULT 0,
        PRIMARY KEY (\`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

const SEED: string[] = [
    `INSERT INTO users (id, username, name, email, password, password_sha, remember_token, created_at, created_by, updated_at, updated_by)
     VALUES (1, 'mazlum', 'Mazlum', 'mazlum@test.local', 'secret', 'sha1', 'token', 1700000000, 1, 1700000000, 1),
            (2, 'mergehez', 'Mergehez', 'mergehez@test.local', 'secret', NULL, NULL, 1700000000, 2, 1700000000, 2),
            (3, 'winter', 'Winter', 'winter@test.local', 'secret', NULL, NULL, 1700000000, 3, 1700000000, 3)`,
    `INSERT INTO topics (id, title, status, mentions, created_at, created_by, updated_at, updated_by)
     VALUES (1, 'first topic', 1, '@mazlum', 1700000000, 1, 1700000000, 1),
            (2, 'second topic', 0, NULL, 1700000000, 2, 1700000000, 2)`,
    `INSERT INTO chat_messages (id, content, receiver_id, read_at, created_at, created_by)
     VALUES (1, 'hello', 2, NULL, 1700000000, 1),
            (2, 'hello back', 1, 1700000100, 1700000100, 2)`,
];

/** Creates the database itself (the specs' pool connects to a database that may not exist yet). */
async function ensureDatabase(): Promise<void> {
    const connection = await mysql.createConnection({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
    });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
    await connection.end();
}

/** The scratch database's own pool: DDL and seeds are not model work, so they do not go through a model. */
function scratchPool(): Pool {
    return mysql.createPool({
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
    });
}

/** Drops and recreates every table, then seeds it — the state a spec can rely on. */
export async function resetExampleSchema(): Promise<void> {
    await ensureDatabase();

    const pool = scratchPool();

    try {
        for (const [table, create] of Object.entries(TABLES)) {
            await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
            await pool.query(create);
        }
        for (const insert of SEED) {
            await pool.query(insert);
        }
    } finally {
        await pool.end();
    }
}
