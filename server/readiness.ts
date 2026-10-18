import type { Company, ReadinessCheck } from '../src/shared/types';
import type { Repository } from './repository';
import { providerKey } from './integrations/models';
import { modelFingerprint } from './integrations/model-catalog';
import { gatewayAvailable } from './whatsapp/client';
import { AI_TERMS_VERSION } from './validation';
import { GATEWAY_HEARTBEAT_STALE_MS } from '../src/shared/whatsapp';

export async function readiness(repo: Repository, company: Company): Promise<ReadinessCheck[]> {
  const [products, integrations] = await Promise.all([
    repo.listProducts(company.id),
    repo.getIntegrations(company.id),
  ]);
  let verified = false;
  try {
    verified =
      company.ai.provider !== 'mock' &&
      company.modelVerification?.fingerprint ===
        modelFingerprint(company, await providerKey(repo, company));
  } catch {
    /* Configuration status never returns credentials. */
  }
  const whatsapp = integrations.find((i) => i.kind === 'whatsapp');
  const connection = await repo.getWhatsAppConnection(company.id);
  const whatsappReady =
    connection?.provider === 'baileys'
      ? gatewayAvailable() &&
        connection.status === 'connected' &&
        !!connection.accountJid &&
        !!connection.lastHeartbeatAt &&
        Date.now() - Date.parse(connection.lastHeartbeatAt) < GATEWAY_HEARTBEAT_STALE_MS
      : (!connection || connection.status !== 'disconnected') &&
        whatsapp?.status === 'connected' &&
        !!whatsapp.config.ownershipVerifiedAt;
  // An approval from before the provider-account confirmations existed still counts, so live
  // bots keep answering, but the owner is asked to confirm them with Connect and test.
  const approval = company.privacy?.aiApproval;
  const confirmed =
    approval?.version === AI_TERMS_VERSION &&
    approval.provider === company.ai.provider &&
    approval.noTrainingOptIn &&
    (company.ai.provider !== 'gemini' || approval.paidTierAttested);
  return [
    { id: 'bot', label: 'Publish a bot configuration', ready: !!company.bot?.published },
    { id: 'menu', label: 'Add an available menu item', ready: products.some((p) => p.available) },
    { id: 'model', label: 'Connect and test the AI model', ready: verified },
    {
      id: 'privacy',
      label: 'Accept the AI data agreement (part of Connect and test)',
      ready: !!company.privacy?.aiDataApproved,
      ...(company.privacy?.aiDataApproved &&
        company.ai.provider !== 'mock' &&
        !confirmed && {
          warning:
            company.ai.provider === 'gemini'
              ? 'Click Connect and test again to confirm the Gemini key is on a paid (billed) Google Cloud project and no data-sharing or training opt-in is on.'
              : 'Click Connect and test again to confirm no data-sharing or training opt-in is on for the AI provider account.',
        }),
    },
    {
      id: 'whatsapp',
      label: 'Verify and connect the business WhatsApp number',
      ready: !!whatsappReady,
    },
    {
      id: 'sheets',
      label: 'Test the order spreadsheet connection',
      ready: integrations.some((i) => i.kind === 'sheets' && i.status === 'connected'),
    },
  ];
}
