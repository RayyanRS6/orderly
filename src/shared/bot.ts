import type { BotConfig, Company } from './types';

export const MAX_BOT_INSTRUCTIONS = 20_000;

export const defaultBot: BotConfig = {
  name: 'Order assistant',
  personality: 'warm',
  language: 'auto',
  goal: 'Collect a complete food order, obtain customer confirmation, and save it pending restaurant acceptance.',
  instructions: '',
  knowledge: [],
  greeting: '',
  handoffMessage: '',
  behaviorRules: [],
  fulfillment: 'both',
  requirePhoneConfirmation: true,
};
export function normalizeBotConfig(value?: Partial<BotConfig> & { steps?: unknown }): BotConfig {
  const { steps: _legacySteps, ...current } = value ?? {};
  return {
    ...defaultBot,
    ...current,
    knowledge: Array.isArray(value?.knowledge) ? value.knowledge : [],
    behaviorRules: Array.isArray(value?.behaviorRules) ? value.behaviorRules : [],
  };
}
export function botConfig(company: Company, draft = false): BotConfig {
  return structuredClone(
    normalizeBotConfig(draft ? company.bot?.draft : company.bot?.published?.config),
  );
}
export function configuredCompany(company: Company, draft = false): Company {
  const config = botConfig(company, draft);
  return { ...company, faqs: [...(company.faqs ?? []), ...config.knowledge] };
}
