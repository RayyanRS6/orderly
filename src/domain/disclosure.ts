import type { Conversation, Language } from '../shared/types';
import { normalizeText as normalize } from './pricing';

/**
 * The AI-assistant notice every chat session starts with. Fixed wording that owner
 * settings cannot remove: only the business name changes. A session is a chat whose last
 * notice is more than a day old, or that staff handed back to the bot since.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const say = (lang: Language, en: string, ur: string, roman: string) =>
  lang === 'ur' ? ur : lang === 'roman-ur' ? roman : en;

// Unicode bidi controls for Latin text inside an Urdu (right-to-left) line. WhatsApp sets a
// line's direction from its first letter, so a Latin name first would lay the Urdu out
// left-to-right, and "+92 300 000 0001" would show its groups in reverse order.
const RLM = '\u200F';
/** A phone number or other left-to-right text kept in order inside Urdu (LRI … PDI). */
export const leftToRight = (text: string) => `\u2066${text}\u2069`;
/** A name in either script kept apart from the Urdu around it (FSI … PDI). */
export const isolated = (text: string) => `\u2068${text}\u2069`;

export function disclosureLine(businessName: string, lang: Language): string {
  const name = businessName.trim() || say(lang, 'This restaurant', 'اس ریسٹورنٹ', 'Is restaurant');
  return say(
    lang,
    `${name}’s AI assistant. Type “staff” anytime to talk to a person.`,
    `${RLM}${isolated(name)} کا اے آئی اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے کسی بھی وقت “عملہ” یا “staff” لکھیں۔`,
    `${name} ka AI assistant. Kisi insaan se baat karne ke liye kabhi bhi “staff” likhein.`,
  );
}
// The part of the notice that is the same for every business, in each language. The earlier
// "automated assistant" wording still counts, so a chat told within the last day is not told again.
const MARKERS = [
  'AI assistant. Type “staff” anytime to talk to a person.',
  'کا اے آئی اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے',
  'ka AI assistant. Kisi insaan se baat karne ke liye',
  'automated assistant. Type “staff” anytime to talk to a person.',
  'کا خودکار اسسٹنٹ۔ کسی انسان سے بات کرنے کے لیے',
  'ka automated assistant. Kisi insaan se baat karne ke liye',
];
const disclosed = (text: string) => MARKERS.some((marker) => text.includes(marker));

/**
 * Whether the next automated reply must carry the notice: no reply in the last 24 hours carried
 * it, or staff handed the chat back since the last one. Replies that did not carry it (a menu
 * page order, a cancellation, anything sent before this notice existed) do not count.
 */
export function needsDisclosure(
  conversation: Pick<Conversation, 'messages' | 'botResumedAt'>,
  now: string,
): boolean {
  const since = Math.max(
    Date.parse(now) - DAY_MS,
    conversation.botResumedAt ? Date.parse(conversation.botResumedAt) : -Infinity,
  );
  return !conversation.messages.some(
    (m) => m.role === 'assistant' && Date.parse(m.createdAt) >= since && disclosed(m.text),
  );
}

/**
 * The reply with the notice on top when this starts a session (see needsDisclosure), else the
 * reply unchanged. An empty reply stays empty. The caller stores and sends the returned text,
 * so the next turn sees that the notice went out.
 */
export function withDisclosure(
  businessName: string,
  conversation: Pick<Conversation, 'messages' | 'botResumedAt'>,
  reply: string,
  lang: Language,
  now: string,
): string {
  if (!reply.trim() || disclosed(reply) || !needsDisclosure(conversation, now)) return reply;
  return `${disclosureLine(businessName, lang)}\n\n${reply}`;
}

/**
 * A whole message asking for a person: "staff", "Human!", "insaan please", "عملہ". Anchored, so a
 * sentence that mentions a person ("2 biryani per person", "staff ne kaha tha") is not a request.
 */
export const isStaffRequest = (text: string) =>
  /^(?:(?:please|pls|plz|ji|bhai|پلیز) )?(?:staff|human|insaan|insan|عملہ|انسان)(?: (?:please|pls|plz|ji|پلیز))?[\s.!?؟،۔]*$/u.test(
    normalize(text),
  );
