/*
|--------------------------------------------------------------------------
| Test runner entrypoint — `bun --env-file=../../.env bin/test.ts`
|--------------------------------------------------------------------------
|
| The adapter's specs run inside an AdonisJS app, since the pieces under test speak its contracts. This is the
| Ignitor boot, and the database connection comes from the repository's `.env`, which the package's `test` script
| loads with `--env-file` (see `start/env.ts`).
*/
process.env.NODE_ENV = 'test';

import { Ignitor, prettyPrintError } from '@adonisjs/core';
import { configure, processCLIArgs, run } from '@japa/runner';
import { spec } from '@japa/runner/reporters';
import 'reflect-metadata';

const APP_ROOT = new URL('../', import.meta.url);

const IMPORTER = (filePath: string) => {
    if (filePath.startsWith('./') || filePath.startsWith('../')) {
        return import(new URL(filePath, APP_ROOT).href);
    }
    return import(filePath);
};

new Ignitor(APP_ROOT, { importer: IMPORTER })
    .tap((app) => {
        app.booting(async () => {
            await import('../start/env.js');
        });
        app.listen('SIGTERM', () => app.terminate());
    })
    .testRunner()
    .configure(async (app) => {
        const { runnerHooks, ...config } = await import('../tests/bootstrap.js');

        processCLIArgs(process.argv.splice(2));
        configure({
            ...app.rcFile.tests,
            ...config,
            setup: runnerHooks.setup,
            teardown: runnerHooks.teardown.concat([() => app.terminate()]),
            reporters: {
                activated: ['spec'],
                list: [spec()],
            },
        });
    })
    .run(() => run())
    .catch((error) => {
        process.exitCode = 1;
        prettyPrintError(error);
    });
