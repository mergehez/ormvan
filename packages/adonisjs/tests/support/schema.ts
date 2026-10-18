/**
 * The specs' scratch database (`DB_DATABASE`, default `orm_test`) is created on demand. The tables the adapter's
 * specs need are the specs' own — the session store builds the one it uses.
 */
import mysql from 'mysql2/promise';

/** Creates the database itself (the specs' pool connects to a database that may not exist yet). */
export async function ensureDatabase(): Promise<void> {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USERNAME ?? 'root',
        password: process.env.DB_PASSWORD ?? '',
    });

    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_DATABASE ?? 'orm_test'}\``);
    await connection.end();
}
