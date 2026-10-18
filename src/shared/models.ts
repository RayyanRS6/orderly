import type { Provider } from './types';

// Single source of truth for model defaults, known prices and the bounds applied to
// every model call. The server adapter enforces these values and the Agent flow page
// displays them, so the explanation can never drift from the running code.

export const PROVIDER_NAMES: Record<Provider, string> = {
  mock: 'Local rules',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

export const MODEL_DEFAULTS: Record<Provider, string> = {
  mock: 'deterministic-demo',
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-3.5-flash-lite',
};

/** Standard USD prices per million input/output tokens. Provider invoices remain authoritative. */
export const KNOWN_MODEL_RATES: Record<string, [number, number]> = {
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-5.4-nano': [0.2, 1.25],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
  'claude-haiku-4-5-20251001': [1, 5],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-3.5-flash-lite': [0.3, 2.5],
};

/** Higher rate cards that apply when a single prompt is larger than a threshold. */
export const LONG_PROMPT_RATES: Record<
  string,
  { aboveInputTokens: number; rate: [number, number] }
> = {
  'claude-haiku-5-5': { aboveInputTokens: 100_000, rate: [0.5, 2.5] },
};

export interface CacheMultipliers {
  read: number;
  write: number;
}
/** Anthropic 5-minute prompt-cache prices as multiples of the input price. */
export const KNOWN_CACHE_MULTIPLIERS: Record<string, CacheMultipliers> = {
  'claude-haiku-5-5': { read: 0.1, write: 1.25 },
  'claude-haiku-4-5': { read: 0.1, write: 1.25 },
  'claude-haiku-4-5-20251001': { read: 0.1, write: 1.25 },
};
/** Other Claude models, or prices typed in by the owner: reused tokens count at full price. */
export const CONSERVATIVE_CACHE_MULTIPLIERS: CacheMultipliers = { read: 1, write: 1.25 };
/** How cached prompt tokens are priced; undefined for providers whose cache Orderly does not use. */
export function cacheMultipliers(
  provider: Provider,
  model: string,
  custom?: [number, number],
): CacheMultipliers | undefined {
  if (provider !== 'anthropic') return undefined;
  return (!custom && KNOWN_CACHE_MULTIPLIERS[model]) || CONSERVATIVE_CACHE_MULTIPLIERS;
}

export const MODEL_LIMITS = {
  /** Most recent conversation messages sent as memory. */
  historyMessages: 24,
  /** Characters kept from each history message. */
  historyMessageChars: 2000,
  /** Largest prompt (menu, knowledge and history) accepted before asking the owner to shorten it. */
  maxPromptBytes: 200_000,
  /** Most actions one reply may propose. */
  maxActions: 6,
  /** One deadline for a reply, retries of a refused call included. */
  timeoutMs: 25_000,
  /** The AI SDK's own retries stay off: Orderly retries only calls that were never billed. */
  retries: 0,
  /** Retries of a call the provider refused unbilled (busy, overloaded, not reachable). */
  refusedRetries: 2,
  /** Longest total wait between those retries, a provider's retry-after included. */
  refusedRetryWaitMs: 10_000,
  /** Output cap for models that answer without a separate thinking phase. */
  maxOutputTokens: 1200,
  /** Output cap when the model thinks before answering; thinking counts toward the cap. */
  thinkingMaxOutputTokens: 4000,
  /** How long a spending reservation is held while a call runs. */
  budgetHoldMs: 120_000,
} as const;

/**
 * Spam protection used when a business has not set its own values. The SQL function
 * ai_limit_settings repeats these numbers; a test keeps the two equal.
 */
export const AI_LIMIT_DEFAULTS = {
  repliesPerHour: 300,
  repliesPerCustomerPerHour: 30,
} as const;
export const AI_LIMIT_RANGES = {
  repliesPerHour: [20, 10000],
  repliesPerCustomerPerHour: [5, 1000],
} as const;
/** How long a customer who reached their own limit waits before the bot answers again. */
export const CUSTOMER_LIMIT_PAUSE_MS = 60 * 60 * 1000;
/** A customer is told about a limit at most once in this time. */
export const LIMIT_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** The limits in force: a saved value outside its range falls back to the default. */
export function effectiveAiLimits(limits?: {
  repliesPerHour?: unknown;
  repliesPerCustomerPerHour?: unknown;
}): { repliesPerHour: number; repliesPerCustomerPerHour: number } {
  const pick = (key: keyof typeof AI_LIMIT_DEFAULTS) => {
    const value = limits?.[key];
    const [min, max] = AI_LIMIT_RANGES[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value
      : AI_LIMIT_DEFAULTS[key];
  };
  return {
    repliesPerHour: pick('repliesPerHour'),
    repliesPerCustomerPerHour: pick('repliesPerCustomerPerHour'),
  };
}

export interface GenerationProfile {
  maxOutputTokens: number;
  /** Anthropic `effort`; set only for models that think by default. */
  effort?: 'low' | 'medium' | 'high';
  thinking: 'adaptive' | 'none';
  summary: string;
}

// Claude 5-generation models think before answering unless told otherwise.
const thinksByDefault = (model: string) => /^claude-[a-z]+-5(?:-|$)/.test(model);

export function generationProfile(provider: Provider, model: string): GenerationProfile {
  if (provider === 'anthropic' && thinksByDefault(model))
    return {
      maxOutputTokens: MODEL_LIMITS.thinkingMaxOutputTokens,
      effort: 'low',
      thinking: 'adaptive',
      summary:
        'Thinks briefly before answering (effort: low) for fast, inexpensive chat replies. Thinking counts toward a 4,000-token output cap.',
    };
  return {
    maxOutputTokens: MODEL_LIMITS.maxOutputTokens,
    thinking: 'none',
    summary: `Answers directly within a ${MODEL_LIMITS.maxOutputTokens.toLocaleString('en-US')}-token output cap.`,
  };
}

export function recommendedModel(provider: Provider, model: string): boolean {
  return MODEL_DEFAULTS[provider] === model;
}
