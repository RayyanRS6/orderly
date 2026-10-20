import { z } from 'zod';
import { MAX_BOT_INSTRUCTIONS, PAYMENT_METHODS } from '../src/shared/bot.js';
import { AI_LIMIT_RANGES, MODEL_LIMITS } from '../src/shared/models.js';
import { PHOTO_URL_RE } from '../src/shared/menu.js';
import { SLUG_RE } from '../src/shared/slug.js';
import { scheduleNeverOccurs } from '../src/shared/hours.js';
import { DEAL_LIMITS } from '../src/shared/deals.js';
import { money } from '../src/shared/types.js';
const text = (max: number) => z.string().trim().max(max);
/** The AI data terms an owner confirms in Connect and test. Raise it when their wording changes. */
export const AI_TERMS_VERSION = 'ai-data-terms-2026-10-18';
/** The stored settings revision (Company.settingsRevision); a business saved before it has 0. */
export const settingsRevision = (company: { settingsRevision?: unknown }): number =>
  typeof company.settingsRevision === 'number' &&
  Number.isInteger(company.settingsRevision) &&
  company.settingsRevision >= 0
    ? company.settingsRevision
    : 0;
/** A company as the dashboard receives it: with its settings revision, 0 when never saved. */
export const withSettingsRevision = <T extends { settingsRevision?: unknown }>(company: T) => ({
  ...company,
  settingsRevision: settingsRevision(company),
});
export const behaviorRuleSchema = z
  .object({
    id: text(80).min(1),
    enabled: z.boolean(),
    when: text(500).min(1),
    action: z.enum(['continue', 'reply', 'handoff']),
    response: text(1500),
    responseMode: z.enum(['exact', 'adaptive']),
  })
  .superRefine((rule, ctx) => {
    if (rule.responseMode === 'exact' && !rule.response)
      ctx.addIssue({
        code: 'custom',
        path: ['response'],
        message: 'Exact rules require reply text.',
      });
  });
export const botSchema = z
  .object({
    name: text(80).min(1),
    personality: z.enum(['warm', 'professional', 'concise']),
    language: z.enum(['auto', 'en', 'ur', 'roman-ur']),
    goal: text(1500).min(1),
    instructions: text(MAX_BOT_INSTRUCTIONS),
    knowledge: z.array(z.object({ question: text(250).min(1), answer: text(1500).min(1) })).max(30),
    greeting: text(500),
    handoffMessage: text(500),
    behaviorRules: z.array(behaviorRuleSchema).max(30).default([]),
    // Accepted temporarily so old saved versions can be restored, then stripped.
    steps: z.array(z.enum(['items', 'fulfillment', 'name', 'address'])).optional(),
    fulfillment: z.enum(['both', 'pickup', 'delivery']),
    requirePhoneConfirmation: z.boolean(),
  })
  .transform(({ steps: _legacySteps, ...config }) => config)
  .superRefine((config, ctx) => {
    if (new Set(config.behaviorRules.map((rule) => rule.id)).size !== config.behaviorRules.length)
      ctx.addIssue({
        code: 'custom',
        path: ['behaviorRules'],
        message: 'Behavior rule IDs must be unique.',
      });
  });
export const optionSchema = z.object({
  id: text(80).min(1),
  name: text(100).min(1),
  price: z.number().int().min(0).max(100_000_000),
});
// An https photo link for the menu page; an emptied field means no photo.
const photoUrl = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .trim()
    .max(500)
    .regex(PHOTO_URL_RE, 'Use a photo link that starts with https://')
    .optional(),
);
export const productSchema = z
  .object({
    id: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    name: text(120).min(1),
    description: text(500).default(''),
    category: text(80).min(1),
    price: z.number().int().min(0).max(100_000_000),
    available: z.boolean(),
    emoji: text(12).default('🍽️'),
    aliases: z.array(text(100)).max(20).default([]),
    variants: z.array(optionSchema).max(15).default([]),
    modifiers: z.array(optionSchema).max(20).default([]),
    imageUrl: photoUrl,
  })
  .superRefine((p, ctx) => {
    for (const key of ['variants', 'modifiers'] as const)
      if (
        new Set(p[key].map((o) => o.id)).size !== p[key].length ||
        new Set(p[key].map((o) => o.name.toLowerCase())).size !== p[key].length
      )
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Option IDs and names must be unique.',
        });
  });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// A form may send an emptied field as '' or null: it means not set.
const blankAsMissing = (v: unknown) => (v === '' || v === null ? undefined : v);
// 'YYYY-MM-DD' that is a real day ('2026-02-30' is not).
const dayDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-08-14.')
  .refine((v) => {
    const at = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(at) && new Date(at).toISOString().startsWith(v);
  }, 'Use a real date.');
export const dealScheduleSchema = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1, 'Choose at least one day.').max(7),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
    startDate: z.preprocess(blankAsMissing, dayDate.optional()),
    endDate: z.preprocess(blankAsMissing, dayDate.optional()),
  })
  .superRefine((schedule, ctx) => {
    if (new Set(schedule.days).size !== schedule.days.length)
      ctx.addIssue({ code: 'custom', path: ['days'], message: 'Choose each day only once.' });
    else if (schedule.startDate && schedule.endDate && schedule.startDate > schedule.endDate)
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'The end date is before the start date.',
      });
    else if (scheduleNeverOccurs(schedule))
      ctx.addIssue({
        code: 'custom',
        path: ['days'],
        message: 'None of the chosen days falls between the start and end dates.',
      });
  });
// The limits are DEAL_LIMITS, which the Deals editor checks before sending.
const D = DEAL_LIMITS;
const dealMoney = () => z.number().int().min(0).max(D.price);
const dealItemSchema = z
  .object({
    name: text(D.itemName).min(1),
    quantity: z.number().int().min(1).max(D.quantity),
    productId: z.preprocess(blankAsMissing, text(80).min(1).optional()),
    variantId: z.preprocess(blankAsMissing, text(80).min(1).optional()),
  })
  .refine((item) => !item.variantId || item.productId, {
    path: ['variantId'],
    message: 'A size needs a linked menu item.',
  });
// Option ids end up in cart modifierIds, which allow 80 characters.
const dealChoiceSchema = z.object({
  id: text(80).min(1),
  name: text(D.choiceName).min(1),
  options: z
    .array(
      z.object({
        id: text(80).min(1),
        name: text(D.optionName).min(1),
        price: dealMoney().default(0),
      }),
    )
    .min(2, 'Give each choice at least 2 options.')
    .max(D.options),
});
/** A deal as the dashboard saves it. The server sets companyId, position and updatedAt. */
export const dealSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: text(D.name).min(1),
    description: text(D.description).default(''),
    emoji: text(D.emoji).default('🎁'),
    imageUrl: photoUrl,
    aliases: z.array(text(D.otherName)).max(D.otherNames).default([]),
    price: dealMoney(),
    regularPrice: z.preprocess(blankAsMissing, dealMoney().optional()),
    items: z.array(dealItemSchema).min(1, 'Add what the deal includes.').max(D.items),
    choices: z.array(dealChoiceSchema).max(D.choices).default([]),
    available: z.boolean(),
    schedule: z.preprocess(blankAsMissing, dealScheduleSchema.optional()),
  })
  .superRefine((deal, ctx) => {
    // A pick is found by its id alone, so ids must be unique across the whole deal.
    const ids = deal.choices.flatMap((group) => [group.id, ...group.options.map((o) => o.id)]);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'Choice IDs must be unique.' });
    if (new Set(deal.choices.map((g) => g.name.toLowerCase())).size !== deal.choices.length)
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'Give each choice its own name.',
      });
    deal.choices.forEach((group, index) => {
      if (new Set(group.options.map((o) => o.name.toLowerCase())).size !== group.options.length)
        ctx.addIssue({
          code: 'custom',
          path: ['choices', index, 'options'],
          message: 'Option names must be unique within a choice.',
        });
    });
  })
  .transform(({ schedule, aliases, ...deal }) => ({
    ...deal,
    aliases: aliases.filter(Boolean),
    // Every day, all day and no dates is the same as no times: on whenever the restaurant is.
    ...(schedule &&
      !(
        schedule.days.length === 7 &&
        schedule.start === schedule.end &&
        !schedule.startDate &&
        !schedule.endDate
      ) && { schedule: { ...schedule, days: [...schedule.days].sort((a, b) => a - b) } }),
  }));
// What the owner reads when a deal is refused: the editor's own words for each field, by its
// path (# for any row), never a path or the validator's wording. The editor checks the same
// first (formProblem), so this is for an older dashboard tab. Messages written on the schema
// already read this way and win over these.
const DEAL_FIELD_WORDS: Record<string, string> = {
  id: 'Reload the page and try again.',
  name: `Give the deal a name of up to ${D.name} characters.`,
  description: `Keep the description to ${D.description} characters or fewer.`,
  emoji: 'Use one emoji, or a few at most.',
  aliases: `Use at most ${D.otherNames} other names.`,
  'aliases.#': `Keep each other name to ${D.otherName} characters or fewer.`,
  price: `Enter a deal price up to ${money(D.price)}.`,
  regularPrice: `Enter a price if bought separately up to ${money(D.price)}, or leave it empty.`,
  items: `A deal can include up to ${D.items} items.`,
  'items.#.name': `Give each included item a name of up to ${D.itemName} characters.`,
  'items.#.quantity': `Give each included item a number from 1 to ${D.quantity}.`,
  'items.#.productId': 'An included item can’t be linked to the menu: unlink it and try again.',
  'items.#.variantId': 'An included item can’t be linked to the menu: unlink it and try again.',
  choices: `A deal can have up to ${D.choices} choices.`,
  'choices.#.name': `Name each choice in up to ${D.choiceName} characters, for example Drink.`,
  'choices.#.options': `Give each choice 2 to ${D.options} options.`,
  'choices.#.options.#.name': `Name each option in up to ${D.optionName} characters.`,
  'choices.#.options.#.price': `Enter each extra charge up to ${money(D.price)}, or leave it empty.`,
  available: 'Reload the page and try again.',
  schedule: 'Reload the page and try again.',
  'schedule.days': 'Choose at least one day.',
  'schedule.days.#': 'Choose at least one day.',
  'schedule.start': 'Enter the time the deal starts and the time it ends.',
  'schedule.end': 'Enter the time the deal starts and the time it ends.',
};
/** For dealSchema.safeParse(body, { error: dealFieldWords }). */
export const dealFieldWords = (issue: { path?: PropertyKey[] }) =>
  DEAL_FIELD_WORDS[
    (issue.path ?? []).map((key) => (typeof key === 'number' ? '#' : String(key))).join('.')
  ] ?? 'Reload the page and try again.';
export const dealAvailableSchema = z.object({ available: z.boolean() }).strict();
export const dealOrderSchema = z
  .object({
    // Every deal the business has, up to what the stores read (1000): the 50-deal limit is
    // checked when a deal is added, and an order must never fail for having more.
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, 'List each deal once.'),
  })
  .strict();
// The settings an owner edits. Fields the server manages (id, createdAt, catalogSyncedAt, the
// AI data approval, linked-phone permission) are not listed, so a copy sent back is dropped.
// A save never changes the slug either; the save route keeps the stored one.
export const companySchema = z
  .object({
    name: text(120).min(1),
    slug: z.string().regex(SLUG_RE).max(140).optional(),
    address: text(500),
    phone: text(40),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid timezone'),
    currency: z.literal('PKR'),
    botEnabled: z.boolean(),
    catalogSource: z.enum(['app', 'sheets']),
    openingHours: z.object({
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      days: z.array(z.number().int().min(0).max(6)).max(7),
    }),
    deliveryZones: z
      .array(z.object({ name: text(100).min(1), fee: z.number().int().min(0).max(100_000_000) }))
      .max(50),
    // How customers may pay. Left out by dashboards from before it: the stored choice stays, and
    // a business that never chose takes cash only.
    paymentMethods: z
      .array(z.enum(PAYMENT_METHODS), 'Choose how customers can pay.')
      .min(1, 'Choose at least one way customers can pay.')
      .max(PAYMENT_METHODS.length)
      .refine((methods) => new Set(methods).size === methods.length, {
        message: 'Choose each payment method only once.',
      })
      .optional(),
    faqs: z.array(z.object({ question: text(250).min(1), answer: text(1500).min(1) })).max(30),
    ai: z.object({
      provider: z.enum(['mock', 'openai', 'anthropic', 'gemini']),
      model: text(120),
      monthlyBudgetUsd: z.number().min(0).max(10000),
      pricing: z
        .tuple([z.number().positive().max(1000), z.number().positive().max(1000)])
        .optional(),
    }),
    aiLimits: z
      .object({
        repliesPerHour: z
          .number()
          .int()
          .min(AI_LIMIT_RANGES.repliesPerHour[0])
          .max(AI_LIMIT_RANGES.repliesPerHour[1]),
        repliesPerCustomerPerHour: z
          .number()
          .int()
          .min(AI_LIMIT_RANGES.repliesPerCustomerPerHour[0])
          .max(AI_LIMIT_RANGES.repliesPerCustomerPerHour[1]),
        // Optional: a dashboard from before this setting leaves it out, and the default applies.
        messagesPerCustomerPerMinute: z
          .number()
          .int()
          .min(AI_LIMIT_RANGES.messagesPerCustomerPerMinute[0])
          .max(AI_LIMIT_RANGES.messagesPerCustomerPerMinute[1])
          .optional(),
      })
      .strict()
      .optional(),
    // The settingsRevision the edited copy was read with. Left out by dashboards from before it.
    settingsRevision: z.number().int().min(0).optional(),
  })
  .superRefine((company, ctx) => {
    if (
      new Set(company.deliveryZones.map((z) => z.name.toLowerCase())).size !==
      company.deliveryZones.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['deliveryZones'],
        message: 'Delivery area names must be unique.',
      });
  });
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('menu'), query: text(200).optional() }),
  z.object({
    type: z.literal('add_item'),
    productId: text(100),
    quantity: z.number().int().min(1).max(50),
    variantId: text(80).optional(),
    modifierIds: z.array(text(80)).max(20).optional(),
    notes: text(300).optional(),
  }),
  z.object({ type: z.literal('remove_item'), productId: text(100) }),
  z.object({
    type: z.literal('set_details'),
    fulfillment: z.enum(['pickup', 'delivery']).optional(),
    customerName: text(100).optional(),
    address: text(500).optional(),
    zone: text(100).optional(),
  }),
  z.object({ type: z.literal('review') }),
  z.object({ type: z.literal('cart_summary') }),
  z.object({ type: z.literal('confirm'), revision: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('new_order') }),
  z.object({ type: z.literal('handoff') }),
  z.object({
    type: z.literal('clarify_item'),
    candidateProductIds: z.array(text(100)).min(2).max(12),
    quantity: z.number().int().min(1).max(50),
    requestedOptionNames: z.array(text(100)).max(20).optional(),
    notes: text(300).optional(),
    originalText: text(2000).optional(),
  }),
  z.object({ type: z.literal('answer'), text: text(2000) }),
]);
// A cart sent by the public menu page. Prices are never sent: the server prices the order.
export const webCartSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            productId: text(100).min(1),
            quantity: z.number().int().min(1).max(50),
            variantId: text(80).min(1).optional(),
            modifierIds: z.array(text(80).min(1)).max(20).default([]),
            notes: z.literal('').default(''),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    fulfillment: z.enum(['pickup', 'delivery']),
    customerName: text(80).min(2),
    address: text(400).min(5).optional(),
    zone: text(100).min(1).optional(),
  })
  .strict();
export const chatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: text(2000).default(''),
  messageId: text(150).min(1),
  action: actionSchema.optional(),
  testTarget: z.enum(['draft', 'published']).default('draft'),
});
export const modelOutputSchema = z.object({
  actions: z.array(actionSchema).min(1).max(MODEL_LIMITS.maxActions),
  response: z
    .object({
      text: text(2000),
      askFor: z.enum(['items', 'fulfillment', 'name', 'zone', 'address', 'anything_else', 'none']),
      matchedRuleId: text(80).optional(),
      groundingIds: z.array(text(120)).max(20).optional(),
    })
    .optional(),
});
