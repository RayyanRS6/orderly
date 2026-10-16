import { randomUUID } from 'node:crypto';
import type { Repository } from './repository.js';
import type { Company, Conversation, Job, Product } from '../src/shared/types.js';
import {
  isPhotoUrl,
  maskPhone,
  MENU_SLUG_RE,
  sortMenuCategories,
  waMeUrl,
  type MenuLinkStatus,
  type MenuSession,
  type PublicMenu,
  type PublicMenuItem,
  type WebCart,
} from '../src/shared/menu.js';
import { connectionMatches, customerKeys } from '../src/shared/whatsapp.js';
import { botConfig, configuredCompany } from '../src/shared/bot.js';
import { isOpen } from '../src/domain/engine.js';
import { buildWebOrder, MenuOrderError } from '../src/domain/web-order.js';
import { env } from './config.js';
import { PublicError } from './security.js';
import { integrationAdapter, refreshCatalog } from './service.js';
import { signMenuToken, verifyMenuToken, type MenuTokenClaims } from './menu-token.js';
import { clientKey } from './client-key.js';
import { dispatchJob, makeJob } from './jobs.js';
import { jobAddress } from './whatsapp/connections.js';

/** A refusal the public page shows, with a code it can act on. */
export class MenuError extends PublicError {
  constructor(
    message: string,
    status: number,
    readonly code: string,
    readonly total?: number,
  ) {
    super(message, status);
  }
}
const NOT_AVAILABLE = "This menu isn't available right now.";

export const appUrl = () => (env('APP_URL') ?? '').trim().replace(/\/+$/, '');
export function appHost(): string | undefined {
  try {
    return new URL(appUrl()).host || undefined;
  } catch {
    return undefined;
  }
}
/** The business's slug, copied once when the owner first turns the link on. */
export function baseSlug(company: Pick<Company, 'id' | 'slug'>): string {
  const slug = company.slug.slice(0, 72).replace(/-+$/, '');
  return MENU_SLUG_RE.test(slug) && slug.length >= 3 ? slug : `menu-${company.id.slice(0, 8)}`;
}
/** The public page's address while the link is on. Never throws. */
export async function menuPublicUrl(repo: Repository, companyId: string) {
  try {
    const link = await repo.getMenuLink(companyId);
    const base = appUrl();
    return link?.enabled && base ? `${base}/m/${link.slug}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The business number customers confirm orders on (digits for wa.me links), from the linked
 * phone while it is connected, otherwise from the connected Meta number.
 */
export async function whatsappNumberFor(repo: Repository, companyId: string) {
  const connection = await repo.getWhatsAppConnection(companyId);
  const digits = (value?: string) => {
    const number = value?.replace(/\D/g, '');
    return number && /^[1-9]\d{5,14}$/.test(number) ? number : undefined;
  };
  if (connection?.provider === 'baileys')
    return ['disconnected', 'logged_out'].includes(connection.status)
      ? undefined
      : digits(connection.phoneNumber);
  if (connection?.status === 'disconnected') return undefined;
  const meta = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
  return meta?.status === 'connected' ? digits(meta.config.displayPhoneNumber) : undefined;
}
/** Best effort: asks Meta for the business number. Linked phones report theirs already. */
export async function refreshDisplayNumber(repo: Repository, companyId: string) {
  try {
    const { displayPhoneNumber } =
      (await (await integrationAdapter(repo, companyId, 'whatsapp')).test()) ?? {};
    if (!displayPhoneNumber) return;
    const latest = (await repo.getIntegrations(companyId)).find((i) => i.kind === 'whatsapp');
    if (!latest) return;
    await repo.saveIntegration(companyId, {
      ...latest,
      config: { ...latest.config, displayPhoneNumber },
    });
  } catch {
    // The owner sees a note instead; the connection test fills the number in later.
  }
}

export async function menuLinkStatus(repo: Repository, company: Company): Promise<MenuLinkStatus> {
  const [link, whatsappNumber] = await Promise.all([
    repo.getMenuLink(company.id).catch(() => undefined),
    whatsappNumberFor(repo, company.id).catch(() => undefined),
  ]);
  const notes: string[] = [];
  if (link?.enabled) {
    if (!company.botEnabled) notes.push('The bot is off, so the page is view-only.');
    if (!whatsappNumber)
      notes.push(
        "We don't know your WhatsApp number yet, so Instagram and QR customers can view the menu but can't confirm orders. Open your WhatsApp connection and run the connection test.",
      );
  }
  const base = appUrl();
  return {
    enabled: !!link?.enabled,
    ...(link && { slug: link.slug }),
    ...(link && base ? { url: `${base}/m/${link.slug}` } : {}),
    personalLinks: true,
    ...(whatsappNumber && { whatsappNumber }),
    notes,
  };
}

const publicItem = (p: Product): PublicMenuItem => ({
  id: p.id,
  name: p.name,
  description: p.description,
  price: p.price,
  available: p.available,
  emoji: p.emoji,
  ...(isPhotoUrl(p.imageUrl) && { imageUrl: p.imageUrl }),
  variants: p.variants.map(({ id, name, price }) => ({ id, name, price })),
  modifiers: p.modifiers.map(({ id, name, price }) => ({ id, name, price })),
});
/** The page's menu: chosen public fields only. Never refreshes a Sheets menu. */
export async function publicMenu(repo: Repository, slug: string, now: string): Promise<PublicMenu> {
  const link = await repo.findMenuLink(slug);
  if (!link?.enabled) throw new MenuError(NOT_AVAILABLE, 404, 'not_found');
  const stored = await repo.getCompany(link.companyId);
  if (!stored) throw new MenuError(NOT_AVAILABLE, 404, 'not_found');
  const company = configuredCompany(stored);
  const products = (await repo.listProducts(company.id)).filter((p) => p.companyId === company.id);
  const offered = botConfig(company).fulfillment;
  const delivers = company.deliveryZones.length > 0;
  const fulfillment =
    offered === 'pickup'
      ? 'pickup'
      : offered === 'delivery'
        ? delivers
          ? 'delivery'
          : undefined
        : delivers
          ? 'both'
          : 'pickup';
  const open = isOpen(company, now);
  const whatsappNumber = await whatsappNumberFor(repo, company.id).catch(() => undefined);
  const reason =
    !fulfillment || !products.some((p) => p.available)
      ? 'unavailable'
      : !company.botEnabled
        ? 'bot_off'
        : !open
          ? 'closed'
          : !whatsappNumber
            ? 'no_whatsapp'
            : undefined;
  return {
    slug: link.slug,
    restaurant: {
      name: company.name,
      address: company.address,
      phone: company.phone,
      timezone: company.timezone,
      openingHours: {
        start: company.openingHours.start,
        end: company.openingHours.end,
        days: [...company.openingHours.days],
      },
      deliveryZones:
        fulfillment === 'pickup' || !fulfillment
          ? []
          : company.deliveryZones.map(({ name, fee }) => ({ name, fee })),
      fulfillment: fulfillment ?? 'pickup',
      currency: 'PKR',
    },
    categories: sortMenuCategories(products).map(({ name, items }) => ({
      name,
      items: items.map(publicItem),
    })),
    ordering: {
      open,
      botOn: company.botEnabled,
      publicOrdering: !reason,
      ...(reason && { reason }),
      ...(whatsappNumber && { whatsappNumber }),
    },
    generatedAt: now,
  };
}

// ── Personal one-tap links ──────────────────────────────────────────────────────────────────

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Called as a reply is sent: the public link becomes this customer's own link. Nothing is
 * saved, so the token never reaches the database, the inbox or the AI. The same job always
 * gets the same text. On any problem, or if the text would be too long, the public link goes.
 */
export async function personalMenuText(
  repo: Repository,
  company: Pick<Company, 'id'>,
  conversation: Conversation,
  job: Pick<Job, 'id' | 'createdAt'>,
  text: string,
): Promise<string> {
  try {
    const url = await menuPublicUrl(repo, company.id);
    if (!url || !text.includes(url)) return text;
    const token = signMenuToken(
      company.id,
      {
        conversationId: conversation.id,
        connectionId: conversation.whatsappAddress?.connectionId,
        generation: conversation.whatsappAddress?.generation,
      },
      { jobId: job.id, issuedAt: job.createdAt },
    );
    if (!token) return text;
    const personal = text.replace(
      new RegExp(`${escapeRegExp(url)}(?![A-Za-z0-9/#?-])`, 'g'),
      `${url}#t=${token}`,
    );
    return personal.length > 4096 ? text : personal;
  } catch {
    return text;
  }
}

// WhatsApp lets a business reply for 24 hours after the customer's last message. A link order's
// confirmation must still fit in that window, so the link stops 5 minutes before.
const LINK_WINDOW_MS = 86_100_000;
const LINK_ENDED = 'This link has expired. Send “menu” in WhatsApp to get a fresh one.';
const STATE_ERRORS: Record<
  Exclude<MenuSession['state'], 'ready' | 'closed'>,
  [status: number, message: string]
> = {
  expired: [410, LINK_ENDED],
  used: [410, LINK_ENDED],
  stale: [410, LINK_ENDED],
  invalid: [410, LINK_ENDED],
  staff: [409, 'Our team is chatting with you on WhatsApp. Continue there to order.'],
  bot_off: [409, 'Online ordering is paused right now. You can still browse the menu.'],
  blocked: [403, 'Ordering isn’t available for this chat.'],
};
const ORDER_ERRORS: Record<MenuOrderError['code'], number> = {
  closed: 409,
  bot_off: 409,
  staff: 409,
  blocked: 403,
  invalid: 422,
  too_large: 422,
  unavailable: 422,
  price_changed: 409,
};
const PRICES_CHANGED =
  'Prices changed since you opened the menu. Please check the new total and tap Place order again.';
function stateError(state: MenuSession['state'], company: Company): MenuError {
  if (state === 'closed')
    return new MenuError(
      `We’re closed right now. We open at ${company.openingHours.start}.`,
      409,
      'closed',
    );
  const [status, message] = STATE_ERRORS[state as keyof typeof STATE_ERRORS] ?? [410, LINK_ENDED];
  return new MenuError(message, status, state);
}
async function limit(repo: Repository, key: string | undefined, max: number) {
  if (key && !(await repo.consumeRateLimit(key, max)))
    throw new MenuError('Too many tries. Please wait a minute and try again.', 429, 'rate');
}
async function menuCompany(repo: Repository, slug: string) {
  const link = await repo.findMenuLink(slug);
  if (!link?.enabled) throw new MenuError(NOT_AVAILABLE, 404, 'not_found');
  const stored = await repo.getCompany(link.companyId);
  if (!stored) throw new MenuError(NOT_AVAILABLE, 404, 'not_found');
  const company = configuredCompany(stored);
  const number = await whatsappNumberFor(repo, company.id).catch(() => undefined);
  return { company, whatsappUrl: number ? waMeUrl(number) : undefined };
}
interface LinkCheck {
  state: MenuSession['state'];
  company: Company;
  whatsappUrl?: string;
  claims?: MenuTokenClaims;
  conversation?: Conversation;
  use?: { orderId: string; conversationId: string };
}
/** Read-only: what a personal link can do now. Never counts a blocked-number hit. */
async function checkLink(repo: Repository, slug: string, token: string): Promise<LinkCheck> {
  const { company, whatsappUrl } = await menuCompany(repo, slug);
  const base = { company, whatsappUrl };
  const now = Date.now();
  const verified = verifyMenuToken(company.id, token, now);
  if (!verified.ok) return { ...base, state: verified.reason };
  const { claims } = verified;
  const conversation = await repo.getConversation(company.id, claims.conversationId);
  if (!conversation || conversation.channel !== 'whatsapp') return { ...base, state: 'invalid' };
  // The chat must still be on the WhatsApp connection the link was sent from.
  const address = conversation.whatsappAddress;
  const connection = await repo.getWhatsAppConnection(company.id);
  const bound = claims.connectionId
    ? !!address &&
      address.connectionId === claims.connectionId &&
      address.generation === claims.generation &&
      connectionMatches(connection, address)
    : !address && !connection;
  const known = { ...base, claims, conversation };
  if (!bound) return { ...known, state: 'stale' };
  const use = await repo.findMenuLinkUse(company.id, claims.nonce);
  if (use) return { ...known, state: 'used', use };
  const keys = customerKeys({ phone: conversation.customerPhone, peer: address?.peer });
  const state: MenuSession['state'] =
    conversation.blocked || (await repo.hasBlockedKey(company.id, keys))
      ? 'blocked'
      : conversation.mode !== 'bot'
        ? 'staff'
        : !company.botEnabled
          ? 'bot_off'
          : !isOpen(company, new Date(now).toISOString())
            ? 'closed'
            : now - Date.parse(conversation.lastInboundAt) >= LINK_WINDOW_MS
              ? 'expired'
              : 'ready';
  return { ...known, state };
}

export async function menuSession(
  repo: Repository,
  slug: string,
  token: string,
  headers: Headers,
): Promise<MenuSession> {
  const ip = clientKey(headers);
  await limit(repo, ip && `menu:session:${ip}`, 120);
  const check = await checkLink(repo, slug, token);
  const session: MenuSession = {
    state: check.state,
    ...(check.whatsappUrl && { whatsappUrl: check.whatsappUrl }),
  };
  if (check.state === 'used' && check.use) {
    const order = await repo.getOrder(check.company.id, check.use.orderId);
    if (order) session.reference = order.reference;
  }
  const chat = check.conversation;
  if (check.state === 'ready' && chat) {
    // A privacy-protected chat (WhatsApp privacy ID) has no number to show.
    const digits = chat.customerPhone.replace(/\D/g, '');
    if (/^[1-9]\d{5,14}$/.test(digits)) session.phoneMasked = maskPhone(digits);
    const name = chat.cart.customerName ?? chat.customerName;
    if (name && name !== 'Guest') session.name = name;
  }
  return session;
}

export interface MenuOrderResult {
  reference: string;
  total: number;
  alreadyPlaced: boolean;
  whatsappUrl?: string;
}
async function alreadyPlaced(repo: Repository, check: LinkCheck): Promise<MenuOrderResult> {
  const order = check.use && (await repo.getOrder(check.company.id, check.use.orderId));
  if (!order) throw stateError('used', check.company);
  return {
    reference: order.reference,
    total: order.total,
    alreadyPlaced: true,
    ...(check.whatsappUrl && { whatsappUrl: check.whatsappUrl }),
  };
}
const catalogChanged = (error: unknown) =>
  error instanceof Error && /Catalog|review again|Order total changed/.test(error.message);

/** The one-tap order from a personal link: one order per link, and only into its own chat. */
export async function placeLinkOrder(
  repo: Repository,
  request: { slug: string; token: string; cart: WebCart; expectedTotal: number; headers: Headers },
): Promise<MenuOrderResult> {
  const ip = clientKey(request.headers);
  await limit(repo, ip && `menu:order:${ip}`, 30);
  let check = await checkLink(repo, request.slug, request.token);
  if (check.conversation) await limit(repo, `menu:order-conv:${check.conversation.id}`, 5);
  if (check.state === 'used') return alreadyPlaced(repo, check);
  if (check.state !== 'ready' || !check.conversation || !check.claims)
    throw stateError(check.state, check.company);
  const companyId = check.company.id;
  const conversationId = check.conversation.id;
  const lockId = randomUUID();
  if (
    !(await repo.acquireConversationLock(
      companyId,
      conversationId,
      lockId,
      new Date(Date.now() + 60000).toISOString(),
    ))
  )
    throw new MenuError('Your order is already being placed. Please wait a moment.', 409, 'busy');
  try {
    // A Sheets menu is refreshed at most once a minute, as for chat orders.
    const synced = check.company.catalogSyncedAt;
    if (
      check.company.catalogSource === 'sheets' &&
      (!synced || Date.now() - Date.parse(synced) > 60000)
    ) {
      try {
        await refreshCatalog(repo, check.company);
      } catch {
        throw new MenuError(
          'The menu is being updated. Please order in WhatsApp for now.',
          409,
          'menu_sync',
        );
      }
    }
    // Read everything again under the lock: a message or staff may have changed the chat.
    check = await checkLink(repo, request.slug, request.token);
    if (check.state === 'used') return alreadyPlaced(repo, check);
    if (check.state !== 'ready' || !check.conversation || !check.claims)
      throw stateError(check.state, check.company);
    const { company, conversation, claims } = check;
    const products = await repo.listProducts(company.id);
    let built: ReturnType<typeof buildWebOrder>;
    try {
      built = buildWebOrder(company, products, conversation, request.cart, {
        now: new Date().toISOString(),
        submissionKey: `${company.id}:${conversation.id}:menu-link:${claims.nonce}`,
        expectedTotal: request.expectedTotal,
      });
    } catch (error) {
      if (!(error instanceof MenuOrderError)) throw error;
      throw new MenuError(
        error.code === 'closed' ? stateError('closed', company).message : error.message,
        ORDER_ERRORS[error.code],
        error.code,
        error.total,
      );
    }
    const { order, reply, replyId } = built;
    const sheets = (await repo.getIntegrations(company.id)).some(
      (i) => i.kind === 'sheets' && i.configured,
    );
    if (sheets) order.syncStatus = 'pending';
    const jobs = [
      ...(sheets ? [makeJob(company.id, 'sheet_sync', { orderId: order.id })] : []),
      makeJob(company.id, 'whatsapp_send', {
        ...jobAddress(conversation),
        conversationId: conversation.id,
        messageId: replyId,
        text: reply,
        cartRevision: built.conversation.cart.revision,
        source: 'notice',
      }),
    ];
    const outcome = await repo
      .placeWebOrder(company.id, built.conversation, conversation.version, order, jobs, {
        kind: 'link',
        nonce: claims.nonce,
        expiresAt: claims.expiresAt,
        keys: customerKeys({
          phone: conversation.customerPhone,
          peer: conversation.whatsappAddress?.peer,
        }),
      })
      .catch((error: unknown) => {
        if (catalogChanged(error)) throw new MenuError(PRICES_CHANGED, 409, 'price_changed');
        throw error;
      });
    const result = (placed: typeof order, again: boolean): MenuOrderResult => ({
      reference: placed.reference,
      total: placed.total,
      alreadyPlaced: again,
      ...(check.whatsappUrl && { whatsappUrl: check.whatsappUrl }),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'duplicate') return result(outcome.order, true);
      if (outcome.reason === 'conversation_changed')
        throw new MenuError('Your chat just changed. Please tap Place order again.', 409, 'retry');
      throw stateError(outcome.reason, company);
    }
    await repo.addTrace({
      id: randomUUID(),
      companyId: company.id,
      conversationId: conversation.id,
      action: 'menu_link_order',
      detail: `Order ${order.reference} placed from a personal menu page link.`,
      createdAt: new Date().toISOString(),
    });
    for (const job of jobs) await dispatchJob(repo, job);
    return result(order, false);
  } finally {
    await repo.releaseConversationLock(companyId, conversationId, lockId);
  }
}
