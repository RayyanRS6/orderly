import { parseArgs } from 'node:util';
import { createDeploymentFile } from './deployment.js';

try {
  const { values } = parseArgs({
    options: {
      hostname: { type: 'string' },
      email: { type: 'string' },
      'events-url': { type: 'string' },
    },
  });
  if (!values.hostname || !values.email || !values['events-url'])
    throw new Error(
      'Usage: npm run configure -- --hostname HOST --email EMAIL --events-url HTTPS_URL',
    );
  createDeploymentFile('.env', values.hostname, values.email, values['events-url']);
  console.info(
    'Created private gateway/.env with independent signing/encryption keys and a one-number pilot limit.',
  );
  console.info(
    'Nothing was deployed. Back up the encryption key securely. Do not paste this file into chat or logs.',
  );
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'Configuration already exists; refusing to overwrite or rotate keys.'
      : 'Configuration not created. Check arguments and file permissions; see gateway/DEPLOYMENT.md.',
  );
  process.exitCode = 1;
}
