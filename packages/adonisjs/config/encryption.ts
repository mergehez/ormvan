import { defineConfig, drivers } from '@adonisjs/core/encryption';
import env from '../start/env.js';

export default defineConfig({
    default: 'app',
    list: {
        app: drivers.aes256cbc({
            id: 'app',
            keys: [env.get('APP_KEY')],
        }),
    },
});
