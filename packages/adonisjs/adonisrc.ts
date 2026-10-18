/**
 * The app the adapter's specs boot — deliberately minimal: an application (for config and the container) and
 * nothing else. No HTTP, no routes, no database provider, no host code: the specs take their connection from
 * `mysql2` themselves (`tests/support/executor.ts`), which is the same seam an app uses.
 */
import { defineConfig } from '@adonisjs/core/app';

export default defineConfig({
    tests: {
        forceExit: false,
        timeout: 5000,
        suites: [
            {
                name: 'adonisjs',
                files: ['tests/**/*.test.ts'],
                timeout: 5000,
            },
        ],
    },

    providers: [() => import('@adonisjs/core/providers/app_provider')],
});
