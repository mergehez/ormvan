/*
|--------------------------------------------------------------------------
| Test runner entrypoint — `bun --env-file=../../.env bin/test.ts`
|--------------------------------------------------------------------------
|
| The specs run without a framework: this file configures Japa, and the setup hook installs a mysql2 executor and
| builds the scratch schema the specs expect (see tests/support). The database connection comes from the repository's
| `.env`, which the package's `test` script loads with `--env-file`.
*/
process.env.NODE_ENV = 'test';

import { assert } from '@japa/assert';
import { expectTypeOf } from '@japa/expect-type';
import { configure, processCLIArgs, run } from '@japa/runner';
import { spec } from '@japa/runner/reporters';
import { bootExampleModels } from '../tests/support/boot.js';
import { closeMySql2Executor, installMySql2Executor } from '../tests/support/executor.js';
import { resetExampleSchema } from '../tests/support/schema.js';

processCLIArgs(process.argv.splice(2));

configure({
    files: ['tests/**/*.test.ts'],
    timeout: 5000,
    plugins: [assert(), expectTypeOf()],
    setup: [
        async () => {
            installMySql2Executor();
            await resetExampleSchema();
            await bootExampleModels();
        },
    ],
    teardown: [
        async () => {
            await closeMySql2Executor();
        },
    ],
    reporters: {
        activated: ['spec'],
        list: [spec()],
    },
});

run().catch((error) => {
    process.exitCode = 1;
    console.error(error);
});
