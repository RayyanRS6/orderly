import { describe, expect, it } from 'vitest';
import { createElement, Component } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
import { BotSettings } from '../src/components/BotSettings';
import { SecuritySettings } from '../src/components/Operations';
import { AI_LIMIT_DEFAULTS, AI_LIMIT_RANGES } from '../src/shared/models';
import App from '../src/App';
import { initials, label, shortDate } from '../src/lib/utils';
import { seedCompanies, seedProducts, seedOrders, seedConversations } from '../src/shared/seed';
import type { Bootstrap } from '../src/shared/types';
import type { PublicMenu } from '../src/shared/menu';
import { addLine, count, previewQuote, setQuantity } from '../src/lib/menu-cart';
import { MenuPage } from '../src/components/MenuPage';

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
    aiConnection: { provider: 'mock', configured: true },
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
    notify: () => {},
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
    expect(htmlEmpty).toContain('No conversations');
  });

  it('renders Playground page cleanly', () => {
    const context = createMockWorkspaceContext(normalData, 'playground');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(Playground)),
    );
    expect(html).toContain('Test your bot');
    expect(html).toContain('Show menu');
    expect(html).toContain('Configuration to test');
    expect(html).toContain('Refresh chat');
    expect(html).toContain('Repeat my order');
    expect(html).toContain('Chat stays saved until you refresh it');
    expect(html).not.toContain('Use selected AI model');
  });

  it('renders behavior rules without the removed collection-flow control', () => {
    const context = createMockWorkspaceContext(normalData, 'bot');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(BotSettings)),
    );
    expect(html).toContain('Behavior rules');
    expect(html).toContain('maxLength="20000"');
    expect(html).toContain('20,000 characters');
    expect(html).not.toContain('Order collection flow');
  });

  it('shows the AI limits with their allowed ranges on Bot settings', () => {
    const context = createMockWorkspaceContext(normalData, 'bot');
    const html = renderToStaticMarkup(
      createElement(Workspace.Provider, { value: context }, createElement(BotSettings)),
    );
    expect(html).toContain('Limits');
    expect(html).toContain('Monthly AI spending limit (USD)');
    expect(html).toContain('AI replies per hour (whole restaurant)');
    expect(html).toContain('AI replies per customer per hour');
    const [minPerHour, maxPerHour] = AI_LIMIT_RANGES.repliesPerHour;
    const [minPerCustomer, maxPerCustomer] = AI_LIMIT_RANGES.repliesPerCustomerPerHour;
    expect(html).toContain(`min="${minPerHour}" max="${maxPerHour}"`);
    expect(html).toContain(`min="${minPerCustomer}" max="${maxPerCustomer}"`);
    // Saved values (or the defaults) fill the boxes; nothing changed yet, so no save button.
    expect(html).toContain(`value="${AI_LIMIT_DEFAULTS.repliesPerHour}"`);
    expect(html).toContain(`value="${AI_LIMIT_DEFAULTS.repliesPerCustomerPerHour}"`);
    expect(html).not.toContain('Save limits');
    expect(html).not.toContain('Save limit only');
    expect(html).toContain('once the limit resets or you raise it');

    const custom = createMockBootstrap({
      company: {
        ...seedCompanies[0],
        aiLimits: { repliesPerHour: 450, repliesPerCustomerPerHour: 12 },
      },
    });
    const customHtml = renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        { value: createMockWorkspaceContext(custom, 'bot') },
        createElement(BotSettings),
      ),
    );
    expect(customHtml).toContain('value="450"');
    expect(customHtml).toContain('value="12"');
  });

  it('marks blocked and AI-limited chats in the Inbox list', () => {
    const base = seedConversations[0];
    const now = new Date().toISOString();
    const data = createMockBootstrap({
      conversations: [
        {
          ...base,
          id: 'blocked-chat',
          customerName: 'Blocked Customer',
          channel: 'whatsapp',
          blocked: { at: now, blockId: 'block-1' },
        },
        {
          ...base,
          id: 'limited-chat',
          customerName: 'Limited Customer',
          channel: 'whatsapp',
          mode: 'human',
          limitPause: {
            reason: 'customer',
            at: now,
            until: new Date(Date.now() + 3600000).toISOString(),
            limit: 30,
          },
        },
        { ...base, id: 'plain-chat', customerName: 'Plain Customer' },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(
        Workspace.Provider,
        { value: createMockWorkspaceContext(data, 'inbox') },
        createElement(Inbox),
      ),
    );
    expect(html).toContain('Blocked Customer');
    expect(html.match(/>Blocked</g)).toHaveLength(1);
    expect(html.match(/>AI limit</g)).toHaveLength(1);
    expect(html).toContain('Plain Customer');
  });

  it('shows the Blocked numbers card on Security & privacy to owners and staff', () => {
    for (const role of ['owner', 'staff'] as const) {
      const html = renderToStaticMarkup(
        createElement(
          Workspace.Provider,
          { value: createMockWorkspaceContext(createMockBootstrap({ role }), 'security') },
          createElement(SecuritySettings),
        ),
      );
      expect(html).toContain('Blocked numbers');
      expect(html).toContain('Messages from these numbers are ignored before they are saved.');
      // Retention stays owner-only, and the blocked list comes before it.
      if (role === 'owner')
        expect(html.indexOf('Blocked numbers')).toBeLessThan(
          html.indexOf('Automatic data retention'),
        );
      else expect(html).not.toContain('Automatic data retention');
    }
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
    expect(htmlSettings).toContain('Business settings');

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
    const firstEarlyReturnIndex = appContent.search(/if\s*\(!data\s*(?:\)|\|\|)/);

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

describe('light public pages', () => {
  const src = join(process.cwd(), 'src');
  // Any of these pulls the dashboard, the dialog library or the bot engine into the menu
  // page's chunk.
  const banned = ['App.tsx', 'lib/workspace.tsx', 'components/ui.tsx', 'domain/engine.ts'].map(
    (file) => join(src, file),
  );
  const real = (file: string) => readFileSync(file, 'utf8');

  // Every module a file loads: imports, re-exports, side-effect imports and import(). A whole
  // `import type` or `export type` line is skipped because the compiler drops it.
  function specifiers(code: string): string[] {
    const lines = code.replace(/^\s*\/\/.*$/gm, '');
    const statics = [
      ...lines.matchAll(
        /^\s*(?:import|export)\s+(type\s+)?(?:[\w\s{},*$]*\sfrom\s*)?['"]([^'"]+)['"]/gm,
      ),
    ];
    const dynamic = [...lines.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)];
    return [...statics.filter((m) => !m[1]).map((m) => m[2]), ...dynamic.map((m) => m[1])];
  }

  // Follows the light files' imports through src/ and lists each import of a banned module.
  function heavyImports(read = real): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const from = relative(process.cwd(), file).replaceAll(sep, '/');
      for (const spec of specifiers(read(file))) {
        if (spec === '@radix-ui' || spec.startsWith('@radix-ui/')) {
          problems.push(`${from} imports ${spec}`);
          continue;
        }
        if (!spec.startsWith('.')) continue;
        const target = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
          .map((ext) => resolve(dirname(file), spec.split('?')[0] + ext))
          .find((path) => existsSync(path) && statSync(path).isFile());
        if (!target) problems.push(`${from} imports ${spec}, which was not found`);
        else if (banned.includes(target)) problems.push(`${from} imports ${spec}`);
        else if (target.startsWith(src + sep) && /\.tsx?$/.test(target)) walk(target);
      }
    };
    for (const file of [
      'components/ui-basic.tsx',
      'components/MenuPage.tsx',
      'lib/menu-cart.ts',
      'shared/menu.ts',
      'domain/pricing.ts',
      'shared/deals.ts',
      'shared/hours.ts',
    ])
      walk(join(src, file));
    return problems;
  }

  it('keeps the basic controls free of the dialog library and the workspace', () => {
    expect(heavyImports()).toEqual([]);
  });

  it('catches the workspace or the dialog library however the menu page reaches it', () => {
    const adding = (file: string, line: string) => (path: string) =>
      path === join(src, file) ? `${line}\n${real(path)}` : real(path);
    expect(heavyImports(adding('components/MenuPage.tsx', "import App from '../App';"))).toEqual([
      'src/components/MenuPage.tsx imports ../App',
    ]);
    expect(
      heavyImports(adding('lib/menu-cart.ts', "import { useWorkspace } from './workspace';")),
    ).toEqual(['src/lib/menu-cart.ts imports ./workspace']);
    // Through a helper the page imports, as a re-export, a side-effect import or import().
    expect(
      heavyImports(adding('lib/utils.ts', "export { Modal } from '../components/ui';")),
    ).toEqual(['src/lib/utils.ts imports ../components/ui']);
    expect(heavyImports(adding('domain/pricing.ts', "import '@radix-ui/react-dialog';"))).toEqual([
      'src/domain/pricing.ts imports @radix-ui/react-dialog',
    ]);
    expect(
      heavyImports(adding('components/ui-basic.tsx', "const app = () => import('../App');")),
    ).toEqual(['src/components/ui-basic.tsx imports ../App']);
    // The deal and hours helpers are shared with the engine, never the other way round.
    expect(
      heavyImports(adding('shared/deals.ts', "import { isOpen } from '../domain/engine';")),
    ).toEqual(['src/shared/deals.ts imports ../domain/engine']);
    // Type-only imports are dropped at build time, so they cost the page nothing.
    expect(
      heavyImports(adding('lib/menu-cart.ts', "import type { Page } from './workspace';")),
    ).toEqual([]);
  });
});

describe('menu page cart', () => {
  const menu: PublicMenu = {
    slug: 'dastarkhwan',
    restaurant: {
      name: 'Dastarkhwan',
      address: '',
      phone: '',
      timezone: 'Asia/Karachi',
      openingHours: { start: '00:00', end: '00:00', days: [0, 1, 2, 3, 4, 5, 6] },
      deliveryZones: [{ name: 'Gulberg', fee: 15000 }],
      fulfillment: 'both',
      currency: 'PKR',
    },
    categories: [
      {
        name: 'Mains',
        items: seedProducts
          .filter((p) => p.companyId === seedCompanies[0].id)
          .map(({ id, name, description, price, available, emoji, variants, modifiers }) => ({
            id,
            name,
            description,
            price,
            available,
            emoji,
            variants,
            modifiers,
          })),
      },
    ],
    ordering: { open: true, botOn: true, publicOrdering: true },
    generatedAt: '2026-10-16T10:00:00.000Z',
  };
  const biryani = seedProducts[0];
  const [raita, chicken] = biryani.modifiers;

  it('merges identical lines, removes at zero and prices like the server', () => {
    let items = addLine([], {
      productId: biryani.id,
      quantity: 1,
      modifierIds: [chicken.id, raita.id],
    });
    items = addLine(items, {
      productId: biryani.id,
      quantity: 2,
      modifierIds: [raita.id, chicken.id],
    });
    items = addLine(items, { productId: biryani.id, quantity: 1, modifierIds: [] });
    expect(items.map((i) => [i.quantity, i.modifierIds.length])).toEqual([
      [3, 2],
      [1, 0],
    ]);
    expect(count(items)).toBe(4);
    expect(previewQuote(menu, { items, fulfillment: 'pickup' }).quote?.total).toBe(
      3 * (45000 + 8000 + 18000) + 45000,
    );
    expect(
      previewQuote(menu, { items, fulfillment: 'delivery', zone: 'Gulberg' }).quote?.total,
    ).toBe(3 * (45000 + 8000 + 18000) + 45000 + 15000);
    expect(previewQuote(menu, { items, fulfillment: 'delivery' }).error).toContain('delivery area');
    expect(setQuantity(items, 0, 0)).toHaveLength(1);
    expect(setQuantity(items, 1, 99)[1]!.quantity).toBe(50);
  });

  it('renders the menu page shell without the workspace', () => {
    const html = renderToStaticMarkup(createElement(MenuPage, { slug: 'dastarkhwan' }));
    expect(html).toContain('Opening the menu…');
  });
});

describe('UI Helper Utilities and Edge Case Resilience', () => {
  it('handles initials safely with nullish, whitespace, or empty input', () => {
    expect(initials(null)).toBe('O');
    expect(initials(undefined)).toBe('O');
    expect(initials('')).toBe('O');
    expect(initials('   ')).toBe('O');
    expect(initials('Orderly')).toBe('O');
    expect(initials('Bun & Co.')).toBe('BC');
    expect(initials('Ali (demo)')).toBe('AD');
    expect(initials('😊 Sana')).toBe('S');
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
        ai: { provider: 'mock', model: 'mock', monthlyBudgetUsd: 10 },
        createdAt: '2026-09-16T12:00:00Z',
      },
      companies: [],
      products: [],
      orders: [],
      conversations: [],
      integrations: [],
      aiConnection: { provider: 'mock', configured: true },
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
