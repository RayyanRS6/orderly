import { parseArgs } from 'node:util';
import { readDeploymentFile, probeGateway } from './deployment.js';

try {
  const { values } = parseArgs({ options: { online: { type: 'boolean', default: false } } });
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node.js 24.');
  const { config, hostname } = readDeploymentFile('.env');
  console.info(
    'PASS: private configuration, HTTPS hostname, callback path, keys and pilot limits.',
  );
  if (values.online) {
    const health = await probeGateway(`https://${hostname}`, config.secret);
    console.info(
      `PASS: HTTPS, signed health, unsigned rejection and replay protection; ${health.workers}/${health.maxSessions} workers.`,
    );
  } else
    console.info(
      'Offline check only. Run npm run doctor -- --online after hosting and DNS are ready.',
    );
  console.info(
    'Not checked: live database migration, backend secrets, callbacks, WhatsApp pairing or real delivery.',
  );
} catch {
  // Do not print raw fetch/config exceptions: they can contain credentials/URLs.
  console.error(
    'Preflight failed. Check gateway/.env permissions/values and, for --online, DNS, TLS, firewall and signing-key agreement.',
  );
  process.exitCode = 1;
}
