/**
 * The app provider instantiates an HTTP server (even without routes), so it needs the `http`
 * config. Kept to what the server requires to construct.
 */
import { defineConfig } from '@adonisjs/core/http';
import app from '@adonisjs/core/services/app';

export const http = defineConfig({
    generateRequestId: true,
    allowMethodSpoofing: false,
    useAsyncLocalStorage: false,
    cookie: {
        domain: '',
        path: '/',
        maxAge: '2h',
        httpOnly: true,
        secure: app.inProduction,
        sameSite: 'lax',
    },
});
