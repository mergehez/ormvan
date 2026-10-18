/**
 * The database connection the specs run against, read from the environment the runner loads
 * (`bun --env-file=../../.env test`). The defaults match the repository's own `.env`, so the specs also run when the
 * variables are set another way.
 */
export const dbConfig = {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USERNAME ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'orm_test',
};
