import type { Company, ReadinessCheck } from '../src/shared/types';
import type { Repository } from './repository';
import { providerKey } from './integrations/models';
import { modelFingerprint } from './integrations/model-catalog';
import { gatewayAvailable } from './whatsapp/client';

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
        Date.now() - Date.parse(connection.lastHeartbeatAt) < 90000
      : (!connection || connection.status !== 'disconnected') &&
        whatsapp?.status === 'connected' &&
        !!whatsapp.config.ownershipVerifiedAt;
  return [
    { id: 'bot', label: 'Publish a bot configuration', ready: !!company.bot?.published },
    { id: 'menu', label: 'Add an available menu item', ready: products.some((p) => p.available) },
    { id: 'model', label: 'Run the selected model generation test', ready: verified },
    {
      id: 'privacy',
      label: 'Approve the AI provider and customer data terms',
      ready: !!company.privacy?.aiDataApproved,
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
