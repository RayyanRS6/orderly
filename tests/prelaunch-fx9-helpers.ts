// Reads the owner's facts in src/components/Legal.tsx (OPERATOR, ONE_OFF_COPY_DAYS) however they
// are written: on the line after `=` (as prettier splits a long string), in single, double or
// back quotes, joined with `+` over several lines, or ONE_OFF_COPY_DAYS as a bare number.
// Used by tests/prelaunch-fx4-legal.test.ts and tests/prelaunch-g-legal.test.ts.

// One string literal: '…' or "…" on one line, or `…` over any number of lines (without ${…}).
const SINGLE = String.raw`'(?:[^'\\\n]|\\.)*'`;
const DOUBLE = String.raw`"(?:[^"\\\n]|\\.)*"`;
const BACK = '`(?:[^`\\\\$]|\\\\[\\s\\S]|\\$(?!\\{))*`';
const LITERAL = `(?:${SINGLE}|${DOUBLE}|${BACK})`;
const declaration = (name: string) =>
  new RegExp(`const ${name} =\\s*(${LITERAL}(?:\\s*\\+\\s*${LITERAL})*|\\d+)\\s*;`);
const unquote = (literal: string) =>
  literal
    .slice(1, -1)
    .replace(/\\([\s\S])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** The value of `const <name> = …;`, whitespace collapsed as the rendered page shows it. */
export function ownerFact(source: string, name: string): string | undefined {
  const value = source.match(declaration(name))?.[1];
  if (value === undefined) return;
  const text = /^\d+$/.test(value)
    ? value
    : [...value.matchAll(new RegExp(LITERAL, 'g'))].map(([literal]) => unquote(literal)).join('');
  return text.replace(/\s+/g, ' ').trim();
}

/** The source with `const <name> = …;` replaced by `const <name> = <literal>;`, in any form. */
export function withOwnerFact(source: string, name: string, literal: string): string {
  return source.replace(declaration(name), () => `const ${name} = ${literal};`);
}

/**
 * What `npm test` checks about the owner's facts: the operator is either still the visible marker
 * or a real value, and the one-off copy period is a number of days.
 */
export function ownerFactProblems(source: string) {
  const problems: string[] = [];
  const operator = ownerFact(source, 'OPERATOR');
  const copyDays = ownerFact(source, 'ONE_OFF_COPY_DAYS');
  if (!operator) problems.push('OPERATOR is missing');
  else if (!/^\[OWNER TO CONFIRM: [^\]]+\]$/.test(operator) && /[[\]]|TO CONFIRM/.test(operator))
    problems.push('OPERATOR is half filled in');
  if (!copyDays) problems.push('ONE_OFF_COPY_DAYS is missing');
  else if (!/^\d+$/.test(copyDays))
    problems.push(`ONE_OFF_COPY_DAYS is ${copyDays}, not a number of days`);
  return problems;
}
