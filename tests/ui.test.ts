import { describe, expect, it } from 'vitest';
import { createElement, Component } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LegalPage } from '../src/components/Legal';
import {
  Badge,
  Status,
  ErrorNotice,
  Empty,
  PageHeading,
  ErrorBoundary,
  CustomSelect,
  Select,
} from '../src/components/ui';
import { Workspace, type WorkspaceContext } from '../src/lib/workspace';
import { Overview, Orders } from '../src/components/Orders';
import { Catalog } from '../src/components/Catalog';
import { Inbox, Playground } from '../src/components/Conversations';
import { Businesses, Integrations, Settings } from '../src/components/Settings';
import { WhatsAppSignup } from '../src/components/WhatsAppSignup';
import App from '../src/App';
import { initials, label, shortDate } from '../src/lib/utils';
import { seedCompanies, seedProducts, seedOrders, seedConversations } from '../src/shared/seed';
import type { Bootstrap } from '../src/shared/types';

function createMockBootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    mode: 'demo',
    role: 'owner',
    company: seedCompanies[0],
    companies: seedCompanies,
    products: seedProducts,
    orders: seedOrders,
    conversations: seedConversations,
    integrations: [
      { kind: 'whatsapp', configured: true, status: 'connected', config: {} },
      { kind: 'sheets', configured: false, status: 'disconnected', config: {} },
      { kind: 'openai', configured: true, status: 'configured', config: {} },
    ],
    aiConnection: { provider: 'mock', keyMode: 'platform', configured: true },
    usage: [],
    traces: [],
    ...overrides,
  };
}

function createMockWorkspaceContext(
  data: Bootstrap,
  page: WorkspaceContext['page'] = 'overview',
): WorkspaceContext {
  return {
    data,
    busy: false,
    error: '',
    clearError: () => {},
    page,
    navigate: () => {},
    switchCompany: () => {},
    refresh: async () => {},
    mutate: async <T>() => ({}) as T,
  };
}

describe('UI components and ErrorBoundary', () => {
  it('renders LegalPage variants cleanly', () => {
    for (const kind of ['privacy', 'terms', 'data-deletion'] as const) {
      const html = renderToStaticMarkup(createElement(LegalPage, { kind }));
      expect(html).toContain('orderly');
    }
  });

  it('renders UI primitives without throwing', () => {
    expect(
      renderToStaticMarkup(createElement(Badge, { tone: 'green', children: 'Active' })),
    ).toContain('Active');
    expect(renderToStaticMarkup(createElement(Status, { value: 'accepted' }))).toContain(
      'Accepted',
    );
    expect(
      renderToStaticMarkup(createElement(ErrorNotice, { message: 'Something broke' })),
    ).toContain('Something broke');
    expect(
      renderToStaticMarkup(createElement(Empty, { title: 'No items', description: 'Empty state' })),
    ).toContain('No items');
    expect(
      renderToStaticMarkup(
        createElement(PageHeading, { title: 'Heading', description: 'Subtext' }),
      ),
    ).toContain('Heading');

    expect(
      renderToStaticMarkup(
        createElement(CustomSelect, {
          value: 'opt1',
          onChange: () => {},
          options: [
            { value: 'opt1', label: 'Option One' },
            { value: 'opt2', label: 'Option Two' },
          ],
        }),
      ),
    ).toContain('Option One');

    expect(
      renderToStaticMarkup(
        createElement(CustomSelect, {
          variant: 'pill',
          value: 'demo',
          onChange: () => {},
          options: [{ value: 'demo', label: 'Bun & Co.' }],
        }),
      ),
    ).toContain('Bun &amp; Co.');

    expect(
      renderToStaticMarkup(
        createElement(CustomSelect, {
          value: '',
          placeholder: 'Select something',
          onChange: () => {},
          options: [],
        }),
      ),
    ).toContain('Select something');

    expect(
      renderToStaticMarkup(
        createElement(Select, {
          theme: 'dark',
          value: 'dark-opt',
          onChange: () => {},
          options: [{ value: 'dark-opt', label: 'Dark Option' }],
        }),
      ),
    ).toContain('Dark Option');
  });

  it('ErrorBoundary renders children normally', () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, null, createElement('div', null, 'Normal content')),
    );
    expect(html).toContain('Normal content');
  });

  it('ErrorBoundary renders fallback UI when in error state', () => {
    const boundary = new ErrorBoundary({ children: createElement('div', null, 'Normal') });
    boundary.state = { hasError: true, error: new Error('Test crash') };
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('Something went wrong');
    expect(html).toContain('Test crash');
    expect(html).toContain('Reload page');
    expect(html).toContain('Reset workspace and return home');
  });
});

describe('Full Component Rendering with Workspace.Provider', () => {
  const normalData = createMockBootstrap();

  it('renders Overview cleanly with standard data', () => {
    const context = createMockWorkspaceContext(normalData, 'overview');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(Overview)),
    );
    expect(html).toContain('A little less busy. A lot more orderly.');
    expect(html).toContain(normalData.company.name);
  });

  it('renders Overview cleanly even with empty arrays and invalid timezone', () => {
    const edgeData = createMockBootstrap({
      orders: [],
      products: [],
      conversations: [],
      traces: [],
      usage: [],
      integrations: [],
      company: {
        ...seedCompanies[0],
        timezone: 'NonExistent/Invalid_Timezone_IANA',
      },
    });
    const context = createMockWorkspaceContext(edgeData, 'overview');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(Overview)),
    );
    expect(html).toContain('A little less busy. A lot more orderly.');
    expect(html).toContain('0 orders in the last 7 days');
  });

  it('renders Orders page with orders table and empty state', () => {
    const withOrdersContext = createMockWorkspaceContext(normalData, 'orders');
    const htmlWithOrders = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: withOrdersContext }, createElement(Orders)),
    );
    expect(htmlWithOrders).toContain('Orders');
    expect(htmlWithOrders).toContain('Search orders');

    const emptyData = createMockBootstrap({ orders: [] });
    const emptyContext = createMockWorkspaceContext(emptyData, 'orders');
    const htmlEmpty = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: emptyContext }, createElement(Orders)),
    );
    expect(htmlEmpty).toContain('Your next order starts here');
  });

  it('renders Catalog page with menu items and empty state', () => {
    const normalContext = createMockWorkspaceContext(normalData, 'menu');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: normalContext }, createElement(Catalog)),
    );
    expect(html).toContain('Your menu');

    const emptyData = createMockBootstrap({ products: [] });
    const emptyContext = createMockWorkspaceContext(emptyData, 'menu');
    const htmlEmpty = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: emptyContext }, createElement(Catalog)),
    );
    expect(htmlEmpty).toContain('A fresh page for your menu');
  });

  it('renders Inbox page with conversations and empty state', () => {
    const normalContext = createMockWorkspaceContext(normalData, 'inbox');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: normalContext }, createElement(Inbox)),
    );
    expect(html).toContain('Inbox');

    const emptyData = createMockBootstrap({ conversations: [] });
    const emptyContext = createMockWorkspaceContext(emptyData, 'inbox');
    const htmlEmpty = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: emptyContext }, createElement(Inbox)),
    );
    expect(htmlEmpty).toContain('Your inbox is ready');
  });

  it('renders Playground page cleanly', () => {
    const context = createMockWorkspaceContext(normalData, 'playground');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(Playground)),
    );
    expect(html).toContain('Test your bot');
    expect(html).toContain('Show menu');
  });

  it('renders Integrations, Settings, and Businesses pages cleanly', () => {
    const integrationsContext = createMockWorkspaceContext(normalData, 'integrations');
    const htmlIntegrations = renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        { value: integrationsContext },
        createElement(Integrations),
      ),
    );
    expect(htmlIntegrations).toContain('Everything, connected.');

    const settingsContext = createMockWorkspaceContext(normalData, 'settings');
    const htmlSettings = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: settingsContext }, createElement(Settings)),
    );
    expect(htmlSettings).toContain('A bot that knows your business.');

    const businessesContext = createMockWorkspaceContext(normalData, 'businesses');
    const htmlBusinesses = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: businessesContext }, createElement(Businesses)),
    );
    expect(htmlBusinesses).toContain('Room for every business.');
  });

  it('renders WhatsAppSignup component without throwing', () => {
    const context = createMockWorkspaceContext(normalData, 'integrations');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(WhatsAppSignup)),
    );
    expect(html).toContain('Connect with Facebook');
  });

  it('renders App initial loading skeleton cleanly when data is null', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('orderly');
    expect(html).toContain('Opening your workspace…');
  });
});

describe('React Hook Order Rules across src/', () => {
  function getTsxFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...getTsxFiles(full));
      } else if (entry.endsWith('.tsx')) {
        results.push(full);
      }
    }
    return results;
  }

  it('ensures no React hooks are declared after early returns in components', () => {
    const files = getTsxFiles(join(process.cwd(), 'src'));
    const hookPattern = /\buse(State|Effect|Callback|Memo|Ref|Context)\b/;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');

      let insideFunction = false;
      let functionName = '';
      let depth = 0;
      let earlyReturnFound = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const fnMatch = line.match(
          /(?:export\s+(?:default\s+)?)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/,
        );
        if (fnMatch) {
          insideFunction = true;
          functionName = fnMatch[1];
          depth = 0;
          earlyReturnFound = false;
        }

        if (insideFunction) {
          const openBraces = (line.match(/\{/g) || []).length;
          const closeBraces = (line.match(/\}/g) || []).length;
          depth += openBraces - closeBraces;

          if (depth === 1 && /^\s*if\s*\(.*?\)\s*return\b/.test(line)) {
            earlyReturnFound = true;
          }

          if (depth === 1 && earlyReturnFound && hookPattern.test(line)) {
            throw new Error(
              `Violation of React Hook Rules in ${file} inside ${functionName} at line ${i + 1}: Hook called after early return: "${line.trim()}"`,
            );
          }

          if (depth <= 0 && openBraces > 0) {
            insideFunction = false;
          }
        }
      }
    }
  });

  it('specifically verifies App.tsx has navSearch declared unconditionally before early returns', () => {
    const appContent = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const navSearchIndex = appContent.indexOf('const [navSearch, setNavSearch] = useState');
    const firstEarlyReturnIndex = appContent.indexOf('if (!data)');

    expect(navSearchIndex).toBeGreaterThan(-1);
    expect(firstEarlyReturnIndex).toBeGreaterThan(-1);
    expect(navSearchIndex).toBeLessThan(firstEarlyReturnIndex);
  });
});

describe('Theme Polish: Dropdowns, Scrollbars, and Sidebar Scrolling', () => {
  function getTsxFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...getTsxFiles(full));
      } else if (entry.endsWith('.tsx')) {
        results.push(full);
      }
    }
    return results;
  }

  it('ensures no native browser <select> elements remain in any src/ tsx components', () => {
    const files = getTsxFiles(join(process.cwd(), 'src'));
    const selectTagRegex = /<\s*select\b/;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(
        selectTagRegex.test(content),
        `Found native <select> tag in ${file}. Replace with CustomSelect.`,
      ).toBe(false);
    }
  });
  it('ensures only the middle navigation section scrolls while top and bottom stay fixed', () => {
    const appContent = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');

    // Sidebar outer container must NOT have overflow-y-auto
    expect(appContent).not.toMatch(/<div[^>]*overflow-y-auto[^>]*bg-\[#121417\]/);

    // Middle navigation wrapper must have flex-1, min-h-0, overflow-y-auto, and custom-scrollbar-dark
    expect(appContent).toMatch(/flex-1[^"]*min-h-0[^"]*overflow-y-auto[^"]*custom-scrollbar-dark/);

    // Top section (Brand, Search, YOUR WORKSPACE) must have shrink-0
    expect(appContent).toMatch(/YOUR WORKSPACE[\s\S]*?shrink-0/);

    // Bottom section must stay pinned at bottom with shrink-0 and mt-auto
    expect(appContent).toMatch(/mt-auto[^"]*shrink-0|shrink-0[^"]*mt-auto/);
  });

  it('ensures index.css defines clean and minimal scrollbar rules', () => {
    const cssContent = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

    expect(cssContent).toContain('scrollbar-width: thin');
    expect(cssContent).toContain('::-webkit-scrollbar');
    expect(cssContent).toContain('.custom-scrollbar');
    expect(cssContent).toContain('custom-scrollbar-dark');
    expect(cssContent).toContain('color-scheme: dark');
  });

  it('ensures CustomSelect renders accessible combobox and supports required validation', () => {
    const html = renderToStaticMarkup(
      createElement(CustomSelect, {
        id: 'test-select',
        name: 'zone',
        required: true,
        value: '',
        placeholder: 'Select an area',
        onChange: () => {},
        options: [
          { value: 'dha', label: 'DHA' },
          { value: 'gulberg', label: 'Gulberg' },
        ],
      }),
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('name="zone"');
    expect(html).toContain('required=""');
    expect(html).toContain('Select an area');
  });
});

describe('UI Helper Utilities and Edge Case Resilience', () => {
  it('handles initials safely with nullish, whitespace, or empty input', () => {
    expect(initials(null)).toBe('O');
    expect(initials(undefined)).toBe('O');
    expect(initials('')).toBe('O');
    expect(initials('   ')).toBe('O');
    expect(initials('Orderly')).toBe('O');
    expect(initials('Bun & Co.')).toBe('B&');
    expect(initials('The Pizza Place')).toBe('TP');
  });

  it('handles label safely with nullish, empty, or underscored strings', () => {
    expect(label(null)).toBe('');
    expect(label(undefined)).toBe('');
    expect(label('')).toBe('');
    expect(label('out_for_delivery')).toBe('Out for delivery');
    expect(label('ready')).toBe('Ready');
  });

  it('handles shortDate safely with nullish, invalid, and valid dates', () => {
    expect(shortDate(null)).toBe('');
    expect(shortDate(undefined)).toBe('');
    expect(shortDate('invalid-date')).toBe('');
    expect(shortDate('2026-09-16T12:00:00Z')).toBeTruthy();
  });

  it('renders Overview and Orders without throwing when all data arrays and company properties are empty/nullish', () => {
    const minimalData: Bootstrap = {
      mode: 'demo',
      role: 'owner',
      company: {
        id: 'c1',
        slug: 'test-slug',
        name: '',
        phone: '',
        address: '',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        openingHours: { start: '09:00', end: '22:00', days: [] },
        deliveryZones: [],
        faqs: [],
        botEnabled: true,
        catalogSource: 'app',
        ai: { provider: 'mock', model: 'mock', keyMode: 'platform', monthlyBudgetUsd: 10 },
        createdAt: '2026-09-16T12:00:00Z',
      },
      companies: [],
      products: [],
      orders: [],
      conversations: [],
      integrations: [],
      aiConnection: { provider: 'mock', keyMode: 'platform', configured: true },
      usage: [],
      traces: [],
    };

    const overviewCtx = createMockWorkspaceContext(minimalData, 'overview');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: overviewCtx }, createElement(Overview)),
      ),
    ).not.toThrow();

    const ordersCtx = createMockWorkspaceContext(minimalData, 'orders');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: ordersCtx }, createElement(Orders)),
      ),
    ).not.toThrow();

    const catalogCtx = createMockWorkspaceContext(minimalData, 'menu');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: catalogCtx }, createElement(Catalog)),
      ),
    ).not.toThrow();

    const inboxCtx = createMockWorkspaceContext(minimalData, 'inbox');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: inboxCtx }, createElement(Inbox)),
      ),
    ).not.toThrow();

    // Verify Settings and Playground render cleanly even when openingHours, deliveryZones, faqs, and ai are completely undefined
    delete (minimalData.company as unknown as Record<string, unknown>).openingHours;
    delete (minimalData.company as unknown as Record<string, unknown>).deliveryZones;
    delete (minimalData.company as unknown as Record<string, unknown>).faqs;
    delete (minimalData.company as unknown as Record<string, unknown>).ai;

    const settingsCtx = createMockWorkspaceContext(minimalData, 'settings');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: settingsCtx }, createElement(Settings)),
      ),
    ).not.toThrow();

    const playgroundCtx = createMockWorkspaceContext(minimalData, 'playground');
    expect(() =>
      renderToStaticMarkup(
        createElement(Workspace.Provider, { value: playgroundCtx }, createElement(Playground)),
      ),
    ).not.toThrow();
  });
});
