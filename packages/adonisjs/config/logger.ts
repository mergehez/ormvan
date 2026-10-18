/**
 * The app provider builds a logger manager, so a minimal logger config has to exist.
 * The tests never want log output, hence `level: 'error'` and no pretty printing.
 */
import { defineConfig } from '@adonisjs/core/logger';

export default defineConfig({
    default: 'app',
    loggers: {
        app: {
            enabled: true,
            name: 'orm',
            level: 'error',
        },
    },
});
