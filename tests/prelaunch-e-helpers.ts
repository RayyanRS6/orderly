import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import { seedCompanies, seedConversations, seedOrders, seedProducts } from '../src/shared/seed';
import type { Bootstrap, ReadinessCheck } from '../src/shared/types';

// Shared by the prelaunch-e page tests: a demo workspace and a server render of one page in it.

export const bootstrap = (overrides: Partial<Bootstrap> = {}): Bootstrap => ({
  mode: 'demo',
  role: 'owner',
  company: seedCompanies[0]!,
  companies: seedCompanies,
  products: seedProducts,
  orders: seedOrders,
  conversations: seedConversations,
  integrations: [],
  aiConnection: { provider: 'mock', configured: true },
  usage: [],
  traces: [],
  ...overrides,
});

export const render = (component: () => unknown, data: Bootstrap, page: WorkspaceContext['page']) =>
  renderToStaticMarkup(
    createElement(
      Workspace.Provider,
      {
        value: {
          data,
          busy: false,
          error: '',
          clearError: () => {},
          page,
          navigate: () => {},
          switchCompany: () => {},
          refresh: async () => {},
          notify: () => {},
          mutate: async <T>() => ({}) as T,
        },
      },
      createElement(component as never),
    ),
  );

export const check = (
  id: string,
  ready: boolean,
  extra: Partial<ReadinessCheck> = {},
): ReadinessCheck => ({ id, label: `${id} label`, ready, ...extra });
