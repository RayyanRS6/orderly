import type {
  ModelSkipReason,
  ModelTextOutcome,
  ReplyPart,
  StaffNoticeCause,
  TurnExplanation,
} from './types';
import type { FlowNodeId } from './agent-flow';
import { PROVIDER_NAMES } from './models';

// Plain-language wording for a reply explanation, shared by Test your bot, the Inbox and
// the Agent flow page so a reply is described the same way everywhere.

export const PART_LABELS: Record<ReplyPart, string> = {
  engine: 'Orderly’s order engine (cart lines, menu, totals and required questions)',
  approved_answer: 'Your approved answer, word for word',
  model: 'The AI model’s wording',
  exact_rule: 'Your rule’s exact wording',
  greeting: 'Your greeting',
  handoff_message: 'Your handoff message',
  fallback: 'A built-in next question',
  notice: 'A built-in notice to the customer',
};

const PART_SHORT: Record<ReplyPart, string> = {
  engine: 'Orderly’s order engine',
  approved_answer: 'your approved answer',
  model: 'the AI model',
  exact_rule: 'your rule’s exact words',
  greeting: 'your greeting',
  handoff_message: 'your handoff message',
  fallback: 'a built-in next question',
  notice: 'a built-in notice',
};

export const MODEL_TEXT_LABELS: Record<ModelTextOutcome, string> = {
  used: 'The AI’s wording was used.',
  none: 'The AI did not write any reply text.',
  replaced: 'The AI’s wording was replaced by your greeting or handoff message.',
  exact_rule: 'Your rule’s exact wording was sent instead of the AI’s.',
  protected:
    'This reply had to be exact (a correction, order summary or confirmation), so the engine wrote it and the AI’s wording was not used.',
  staff_mode: 'The chat moved to staff, so the AI’s wording was not used.',
  ungrounded:
    'The AI cited facts that are not in your menu or business info, so its wording was dropped.',
  invalid_question:
    'The AI asked for a detail the customer already gave, so its question was dropped.',
  unsafe:
    'The AI’s wording mentioned prices, totals, a confirmed order or a web link you didn’t provide, so it was dropped.',
};

export const SKIP_LABELS: Record<ModelSkipReason, string> = {
  button: 'The customer tapped a button (or sent media), so no AI was needed.',
  late: 'This message reached Orderly more than 2 hours late, so staff were asked to look at it; the bot answers the customer’s next message.',
  local_rules: 'No AI model is selected, so built-in rules handled the message.',
  staff_mode: 'Staff are handling this chat, so the AI was not used.',
  paused: 'Automatic replies are paused, so the AI was not used.',
  cancellation: 'The customer asked to cancel a submitted order, so no AI was needed.',
  menu_page: 'The customer ordered from your menu page, so no AI was needed.',
};

export const NOTICE_LABELS: Record<StaffNoticeCause, string> = {
  burst:
    'Many messages arrived within a minute, so automatic replies to this customer paused for 15 minutes.',
  menu_sync: 'The menu Sheet could not be refreshed, so the chat was handed to staff.',
  ai_error:
    'The AI model could not answer, so the chat paused; after 10 minutes the bot answers the customer’s next message, unless staff reply.',
  // Also describes older handoffs that stay with staff, so it promises no automatic return.
  ai_budget: 'The monthly AI spending limit was reached, so staff were asked to reply.',
  hourly_limit:
    'The restaurant reached its AI replies for this hour, so staff were asked to reply. The bot answers again next hour, or sooner if the limit is raised.',
  customer_limit:
    'This customer reached their AI replies for the hour, so staff were asked to reply. The bot answers them again after an hour.',
};

const STEP_LABELS: Record<string, string> = {
  menu: 'Showed the menu',
  add_item: 'Added to cart',
  remove_item: 'Removed from cart',
  set_details: 'Saved order details',
  review: 'Showed order summary',
  cart_summary: 'Showed the cart',
  confirm: 'Customer confirmed',
  cancel: 'Cancellation requested',
  new_order: 'Started a new order',
  handoff: 'Handed to staff',
  clarify_item: 'Asked which item',
  answer: 'Answered a question',
  approved_faq: 'Used an approved answer',
  grounded_model_answer: 'AI answered from your info',
  order_pending_restaurant_acceptance: 'Saved a pending order',
  order_cancelled: 'Cancelled the order',
  staff_attention: 'Notified staff',
  human_mode_message_saved: 'Saved for staff',
  menu_page_order: 'Saved an order from the menu page',
  menu_code_refused: 'Could not use the menu page order code',
  order_status: 'Told the customer where their order is',
  allergy_question_guarded: 'Answered an allergy question safely',
  allergy_assurance_ignored: 'Dropped an allergy promise',
};

const CORRECTION_LABELS: Record<string, string> = {
  recap_shown:
    'The customer asked to see their order, so the cart was shown instead of a checkout step.',
  too_many_actions: 'Too many requests in one message, so the customer was asked to split it.',
  ambiguous_addition_prevented:
    'The AI added an item, but the name matched several dishes, so the customer was asked to choose.',
  item_choice_resolved: 'The customer’s answer settled an earlier “which one?” question.',
  browse_cart_mutation_prevented:
    'The customer was only browsing, so the AI’s cart change was undone and the menu was shown.',
  unconfirmed_model_action_rejected:
    'The AI tried to confirm without a clear “yes”, so no order was placed.',
  fresh_confirmation_required:
    'The cart changed since the last summary, so a fresh confirmation was requested.',
  duplicate_submission_prevented: 'This order was already submitted, so no duplicate was created.',
  invalid_model_grounding_ignored:
    'The AI referenced facts that don’t exist, so its wording was dropped.',
  unsafe_model_response_ignored:
    'The AI’s wording stated prices or a confirmation, so it was dropped.',
  invalid_model_prompt_ignored:
    'The AI’s follow-up question didn’t fit the order so far, so its wording was dropped.',
  response_fallback: 'There was no usable reply text, so a built-in next question was sent.',
  invented_link_ignored:
    'The AI’s wording included a web link you didn’t provide, so it was dropped.',
  allergy_question_guarded:
    'The customer asked about allergies, so your approved allergy answer was sent word for word; without one, a fixed safety notice was sent and the chat went to staff.',
  allergy_assurance_ignored:
    'The AI’s wording promised something about allergies or ingredients, so it was dropped.',
};

/** Recorded events (Activity) whose code name says too little on its own. */
const TRACE_ACTION_LABELS: Record<string, string> = {
  staff_attention: 'Staff asked to look at a chat',
  menu_sync_stale: 'Menu Sheet unreadable, last good menu still used',
  order_followup: 'Customer told their order is still waiting',
  'whatsapp.not_sent': 'WhatsApp reply not sent',
  'budget.settle_failed': 'AI reply cost not recorded',
};

/** Why staff were asked to look at a chat (the code of a 'staff_attention' event). */
export const ATTENTION_CODE_LABELS: Record<string, string> = {
  ai_auth: 'the AI provider rejected the API key',
  ai_quota: 'the AI account has no quota or credit left',
  ai_rate_limited: 'the AI provider is limiting requests',
  ai_overloaded: 'the AI provider is overloaded',
  ai_timeout: 'the AI model did not answer in time',
  ai_model_not_found: 'the AI model is not offered to this key',
  ai_bad_output: 'the AI model’s reply could not be used',
  ai_unreachable: 'the AI provider could not be reached',
  ai_provider_error: 'the AI model could not answer',
  ai_unavailable: 'the AI model could not answer',
  store_unavailable: 'Orderly’s database was busy',
  burst: 'many messages arrived at once',
  late: 'the message reached Orderly hours late',
};

const humanize = (value: string) => value.replaceAll('_', ' ');

/**
 * A recorded event's heading in plain words, or undefined to show its code name. A staff alert
 * with a known reason says why: “Staff asked to look at a chat: the AI provider is overloaded”.
 */
export function describeTrace(action: string, code?: string): string | undefined {
  const heading = TRACE_ACTION_LABELS[action];
  const reason = code ? ATTENTION_CODE_LABELS[code] : undefined;
  return heading && reason && action === 'staff_attention' ? `${heading}: ${reason}` : heading;
}

export function describeStep(step: string): string {
  if (step.startsWith('behavior_rule:')) return 'Matched your rule';
  if (step.startsWith('validation_failed:'))
    return `Rejected ${humanize(step.split(':')[1] ?? '')}`;
  if (step.startsWith('cancel_submitted:')) return 'Passed the cancellation to staff';
  return STEP_LABELS[step] ?? humanize(step);
}

export function describeCorrection(correction: string): string {
  if (correction.startsWith('validation_failed:'))
    return `The engine rejected a proposed “${humanize(correction.split(':')[1] ?? '')}” (for example a sold-out item, a closed restaurant or a missing detail).`;
  return CORRECTION_LABELS[correction] ?? humanize(correction);
}

export function describeConfig(explanation: TurnExplanation): string {
  const { config } = explanation;
  const settings =
    config.target === 'draft'
      ? `Draft settings (revision ${config.revision})`
      : config.version
        ? `${config.target === 'live' ? 'Live' : 'Published'} settings v${config.version}`
        : 'Default settings (nothing published)';
  if (explanation.provider === 'mock') return `${settings} · no AI model`;
  return `${settings} · ${PROVIDER_NAMES[explanation.provider]} ${explanation.model}`;
}

/** One-sentence headline for a reply. */
export function explanationHeadline(explanation: TurnExplanation): string {
  if (explanation.notice) return NOTICE_LABELS[explanation.notice];
  if (explanation.outcome === 'order')
    return `The customer confirmed, so ${
      explanation.orderReference ? `order ${explanation.orderReference}` : 'the order'
    } was saved for staff to accept.`;
  const { decision } = explanation;
  const writers = decision.parts.map((part) => PART_SHORT[part]);
  const rule = decision.matchedRule;
  if (rule) {
    const matched = `Your rule “${rule.when}” matched`;
    const exactWords = decision.parts.includes('exact_rule') ? ' using your exact words' : '';
    if (rule.action === 'handoff')
      return `${matched}, so the bot handed the chat to staff${exactWords}.`;
    if (explanation.outcome === 'staff') return `${matched}, but the chat was handed to staff.`;
    if (!exactWords && !decision.parts.includes('model'))
      return `${matched}, but this reply came from ${writers.join(' + ') || 'Orderly'} instead.`;
    return `${matched}, so the bot ${
      rule.action === 'reply' ? 'replied without changing the order' : 'continued the order'
    }${exactWords}.`;
  }
  if (explanation.outcome === 'staff') return 'The chat was handed to staff.';
  return writers.length ? `Written by ${writers.join(' + ')}.` : 'No reply text.';
}

/** The flow nodes this reply passed through, and where it stopped if it failed. */
export function explanationPath(explanation: TurnExplanation): {
  nodes: FlowNodeId[];
  stoppedAt?: FlowNodeId;
} {
  const nodes: FlowNodeId[] = [explanation.channel === 'whatsapp' ? 'channel' : 'sandbox', 'gates'];
  const notice = explanation.notice;
  if (notice === 'burst')
    return { nodes: [...nodes, 'router', 'reply', 'staff'], stoppedAt: 'gates' };
  if (notice === 'menu_sync')
    return { nodes: [...nodes, 'menu', 'router', 'reply', 'staff'], stoppedAt: 'menu' };
  if (explanation.ai.called || notice)
    nodes.push('agent', 'model', 'memory', 'menu', 'knowledge', 'instructions');
  if (notice) return { nodes: [...nodes, 'router', 'reply', 'staff'], stoppedAt: 'model' };
  nodes.push('engine', 'router', 'reply');
  if (explanation.outcome === 'order')
    nodes.push('order', ...(explanation.channel === 'whatsapp' ? (['sheets'] as const) : []));
  if (explanation.outcome === 'staff') nodes.push('staff');
  return { nodes };
}
