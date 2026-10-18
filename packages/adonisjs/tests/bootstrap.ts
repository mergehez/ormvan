import app from '@adonisjs/core/services/app';
import { assert } from '@japa/assert';
import { expectTypeOf } from '@japa/expect-type';
import { pluginAdonisJS } from '@japa/plugin-adonisjs';
import type { Config } from '@japa/runner/types';
import { closeMySql2Executor, installMySql2Executor } from './support/executor.js';
import { ensureDatabase } from './support/schema.js';

export const plugins: Config['plugins'] = [assert(), expectTypeOf(), pluginAdonisJS(app)];

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
    setup: [
        async () => {
            installMySql2Executor();
            await ensureDatabase();
        },
    ],
    teardown: [
        async () => {
            await closeMySql2Executor();
        },
    ],
};
