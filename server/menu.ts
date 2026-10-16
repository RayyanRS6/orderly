import type { Repository } from './repository.js';
import type { Company, Product } from '../src/shared/types.js';
import {
  isPhotoUrl,
  MENU_SLUG_RE,
  sortMenuCategories,
  type MenuLinkStatus,
  type PublicMenu,
  type PublicMenuItem,
} from '../src/shared/menu.js';
import { botConfig, configuredCompany } from '../src/shared/bot.js';
import { isOpen } from '../src/domain/engine.js';
import { env } from './config.js';
import { PublicError } from './security.js';
import { integrationAdapter } from './service.js';

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
