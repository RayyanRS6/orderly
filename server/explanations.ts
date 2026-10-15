import type {
  Company,
  Conversation,
  ModelInterpretation,
  ModelSkipReason,
  ReplyDecision,
  StaffNoticeCause,
  TurnExplanation,
  TurnInput,
} from '../src/shared/types.js';

// Explanations are stored on the bot reply itself (conversation JSON), so they are saved
// atomically with the turn and erased with the conversation. They hold configuration and
// action metadata only: no prompts, customer names, addresses or free text.

function configUsed(
  company: Company,
  conversation: Conversation,
  input: TurnInput,
): TurnExplanation['config'] {
  const revision = company.bot?.revision ?? 0;
  if (conversation.channel !== 'demo')
    return { target: 'live', revision, version: company.bot?.published?.version };
  return input.testTarget === 'published'
    ? { target: 'published', revision, version: company.bot?.published?.version }
    : { target: 'draft', revision };
}

function aiCall(
  interpretation?: ModelInterpretation,
  skipped?: ModelSkipReason,
  ruleOverride?: 'handoff' | 'reply',
): TurnExplanation['ai'] {
  if (!interpretation) return { called: false, ...(skipped && { skipped }) };
  return {
    called: true,
    proposed: interpretation.actions.slice(0, 8).map((action) => ({
      type: action.type,
      ...('productId' in action && { productId: action.productId.slice(0, 100) }),
      ...('quantity' in action && { quantity: action.quantity }),
    })),
    askFor: interpretation.response?.askFor,
    groundingIds: interpretation.response?.groundingIds?.slice(0, 20).map((id) => id.slice(0, 120)),
    ...(ruleOverride && { ruleOverride }),
    ...(interpretation.usage && { usage: interpretation.usage }),
  };
}

export function describeTurn(details: {
  company: Company;
  conversation: Conversation;
  input: TurnInput;
  steps: string[];
  decision: ReplyDecision;
  outcome: TurnExplanation['outcome'];
  orderReference?: string;
  interpretation?: ModelInterpretation;
  skipped?: ModelSkipReason;
  ruleOverride?: 'handoff' | 'reply';
  notice?: StaffNoticeCause;
}): TurnExplanation {
  const { company, conversation, input } = details;
  return {
    v: 1,
    channel: conversation.channel,
    config: configUsed(company, conversation, input),
    provider: company.ai.provider,
    model: company.ai.model,
    catalogSource: company.catalogSource,
    ai: aiCall(details.interpretation, details.skipped, details.ruleOverride),
    steps: details.steps.slice(0, 40).map((step) => step.slice(0, 120)),
    decision: details.decision,
    outcome: details.outcome,
    ...(details.orderReference && { orderReference: details.orderReference }),
    ...(details.notice && { notice: details.notice }),
  };
}

/** Attaches the explanation to the reply message, matched by id. */
export function attachExplanation(
  conversation: Conversation,
  messageId: string,
  explanation: TurnExplanation,
) {
  const message = conversation.messages.find(
    (item) => item.id === messageId && item.role === 'assistant',
  );
  if (message) message.explanation = explanation;
}
