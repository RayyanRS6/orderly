import type { Company, Conversation } from '../shared/types';

export interface TestChatSession {
  conversationId?: string;
  target: 'draft' | 'published';
}
const prefix = 'orderly.test-chat.v1:';
const fallback = new Map<string, TestChatSession>();

// Store only a pointer. Messages/cart are restored through the authenticated API,
// not copied into browser storage or trusted from a previous login.
export function readTestChat(companyId: string): TestChatSession {
  try {
    const value = JSON.parse(sessionStorage.getItem(prefix + companyId) || 'null');
    if (
      value &&
      ['draft', 'published'].includes(value.target) &&
      (!value.conversationId || /^[a-f0-9-]{36}$/i.test(value.conversationId))
    )
      return value;
  } catch {
    /* Storage can be disabled by the browser. */
  }
  return fallback.get(companyId) ?? { target: 'draft' };
}

export function saveTestChat(companyId: string, session: TestChatSession): void {
  fallback.set(companyId, session);
  try {
    sessionStorage.setItem(prefix + companyId, JSON.stringify(session));
  } catch {
    /* Keep navigation persistence even when browser storage is disabled. */
  }
}

export function testChatMatches(
  company: Company,
  conversation: Conversation,
  target: TestChatSession['target'],
): boolean {
  const context = conversation.testContext;
  return (
    conversation.companyId === company.id &&
    conversation.channel === 'demo' &&
    !!context &&
    context.target === target &&
    context.configRevision ===
      (target === 'draft'
        ? (company.bot?.revision ?? 0)
        : (company.bot?.published?.version ?? 0)) &&
    context.provider === company.ai.provider &&
    context.model === company.ai.model &&
    context.keyMode === company.ai.keyMode &&
    context.catalogSource === company.catalogSource
  );
}
