import { fetchLatestBaileysVersion, DEFAULT_CONNECTION_CONFIG } from '@whiskeysockets/baileys';
// Operator inspection only: this command never changes a running connection.
const latest = await fetchLatestBaileysVersion({ timeout: 10000 });
console.info(
  JSON.stringify(
    {
      library: '6.7.22',
      bundled: DEFAULT_CONNECTION_CONFIG.version,
      candidate: latest.version,
      fetched: latest.isLatest,
      note: 'Test candidate on an authorized canary before setting GATEWAY_WA_VERSION. No configuration was changed.',
    },
    null,
    2,
  ),
);
