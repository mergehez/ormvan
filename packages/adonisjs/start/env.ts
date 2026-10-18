import { Env } from '@adonisjs/core/env';

/**
 * The adapter's specs run with the repository's `.env`: the URL below is the monorepo root, so `Env` finds that file
 * even when the runner is invoked without `--env-file`. This is test scaffolding — `start/` is never published.
 */
export default await Env.create(new URL('../../../', import.meta.url), {
    NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
    APP_KEY: Env.schema.string(),

    DB_CONNECTION: Env.schema.enum(['mysql'] as const),
    DB_HOST: Env.schema.string(),
    DB_PORT: Env.schema.number(),
    DB_USERNAME: Env.schema.string(),
    DB_PASSWORD: Env.schema.string.optional(),
    DB_DATABASE: Env.schema.string(),
});
