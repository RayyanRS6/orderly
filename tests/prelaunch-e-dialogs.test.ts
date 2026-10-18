import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('tall dialogs on phones', () => {
  it('keep their close button in reach without changing larger screens', () => {
    // A zero-height sticky strip below sm; from sm up it is `contents`, so Close is laid out
    // exactly as before.
    expect(source('src/components/ui.tsx')).toMatch(
      /<div className="sticky top-6 z-10 h-0 sm:contents">\s*<Dialog\.Close\s*className="icon-btn absolute right-5 top-5 bg-ink\/\[0\.04\] max-sm:/,
    );
    // Only phone (max-sm) classes are added to the staff alerts header.
    expect(source('src/components/StaffAlerts.tsx')).toContain(
      'className="mb-4 flex items-center justify-between gap-2 max-sm:sticky max-sm:top-0',
    );
  });
});
