import { createApp } from '../server/app.js';
import { createRepository } from '../server/repository.js';
import { appMode } from '../server/config.js';
appMode();
const app = createApp(createRepository());
export default { fetch: (request: Request) => app.fetch(request) };
