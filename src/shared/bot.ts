import type { BotConfig, Company } from './types';

export const defaultBot: BotConfig = {
  name: 'Order assistant', personality: 'warm', language: 'auto',
  goal: 'Collect a complete food order, obtain customer confirmation, and save it pending restaurant acceptance.',
  instructions: '', knowledge: [], greeting: '', handoffMessage: '',
  steps: ['items', 'fulfillment', 'name', 'address'], fulfillment: 'both', requirePhoneConfirmation: true,
};
export function botConfig(company: Company, draft = false): BotConfig {
  return structuredClone((draft ? company.bot?.draft : company.bot?.published?.config) ?? defaultBot);
}
export function configuredCompany(company: Company, draft = false): Company {
  const config = botConfig(company, draft);
  return { ...company, faqs: [...(company.faqs ?? []), ...config.knowledge] };
}
