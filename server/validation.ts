import { z } from 'zod';
import { MAX_BOT_INSTRUCTIONS, PAYMENT_METHODS } from '../src/shared/bot.js';
import { AI_LIMIT_RANGES, MODEL_LIMITS } from '../src/shared/models.js';
import { PHOTO_URL_RE } from '../src/shared/menu.js';
import { SLUG_RE } from '../src/shared/slug.js';
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
    imageUrl: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z
        .string()
        .trim()
        .max(500)
        .regex(PHOTO_URL_RE, 'Use a photo link that starts with https://')
        .optional(),
    ),
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
