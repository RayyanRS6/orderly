import { handleCallback } from '@vercel/queue';
import { createRepository } from '../server/repository.js';
import { processJob } from '../server/service.js';
import { appMode } from '../server/config.js';
appMode();
const repo = createRepository();
export const POST = handleCallback<{ jobId: string }>(
  async (message) => {
    await processJob(repo, message.jobId);
  },
  { visibilityTimeoutSeconds: 90 },
);
