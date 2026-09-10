import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createRepository } from './repository.js';
import { appMode } from './config.js';
appMode();
const app = createApp(createRepository());
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 4000 }, () =>
  console.log('Orderly API ready at http://127.0.0.1:4000'),
);
