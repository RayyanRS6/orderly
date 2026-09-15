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

  it('ensures the sidebar scrolls as a unified unit instead of an isolated nav section', () => {
    const appContent = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');

    // Main nav must NOT have overflow-y-auto
    expect(appContent).not.toMatch(/<nav[^>]*aria-label="Main navigation"[^>]*overflow-y-auto/);

    // Sidebar outer container must have overflow-y-auto and dark scrollbar styling
    expect(appContent).toMatch(/overflow-y-auto[^"]*bg-\[#121417\][^"]*custom-scrollbar-dark/);
  });

  it('ensures index.css defines clean and minimal scrollbar rules', () => {
    const cssContent = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

    expect(cssContent).toContain('scrollbar-width: thin');
    expect(cssContent).toContain('::-webkit-scrollbar');
    expect(cssContent).toContain('custom-scrollbar-dark');
  });
});
