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
} from '../src/components/ui';

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
