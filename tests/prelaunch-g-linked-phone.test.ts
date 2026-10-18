import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WhatsAppConnection } from '../src/components/WhatsAppConnection';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import { seedCompanies, seedConversations, seedOrders, seedProducts } from '../src/shared/seed';
import type { Bootstrap } from '../src/shared/types';

const data: Bootstrap = {
  mode: 'demo',
  role: 'owner',
  company: seedCompanies[0],
  companies: seedCompanies,
  products: seedProducts,
  orders: seedOrders,
  conversations: seedConversations,
  integrations: [],
  aiConnection: { provider: 'mock', configured: true },
  usage: [],
  traces: [],
};
const workspace: WorkspaceContext = {
  data,
  busy: false,
  error: '',
  clearError: () => {},
  page: 'integrations',
  navigate: () => {},
  switchCompany: () => {},
  refresh: async () => {},
  notify: () => {},
  mutate: async <T>() => ({}) as T,
};

describe('linked-phone risk notice and consent', () => {
  it('says the method breaks WhatsApp’s terms, what a ban hits, and where messages go', () => {
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: workspace }, createElement(WhatsAppConnection)),
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(html).toContain('unofficial method that is against WhatsApp’s terms');
    expect(html).toContain('WhatsApp can ban the whole number, temporarily or permanently');
    expect(html).toContain('the restaurant’s own WhatsApp app on that number stops working too');
    expect(html).toContain('decrypted and processed on Orderly’s gateway server (Railway)');
    expect(html).toContain('The supported route is the official WhatsApp Business Platform');
    expect(html).toContain('coexistence');
    expect(html).not.toContain('No ban-free guarantee');
  });

  it('asks the owner to accept those exact risks before pairing', () => {
    // The checkbox only renders once the gateway is enabled, so check its source text.
    const source = readFileSync(
      join(process.cwd(), 'src/components/WhatsAppConnection.tsx'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(source).toContain(
      'I have the owner’s permission. I understand this unofficial connection is against WhatsApp’s terms, that WhatsApp can ban the whole number temporarily or permanently, including the restaurant’s own WhatsApp app, and that messages are processed on Orderly’s gateway server.',
    );
    expect(source).not.toContain('accept the unofficial connection risks');
  });
});
