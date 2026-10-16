// Reads the instruction text and prompt from a mocked generateText call, whichever form the
// adapter used (a plain string, or a system message that also carries provider options).

export function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (
    system &&
    typeof system === 'object' &&
    (system as { role?: unknown }).role === 'system' &&
    typeof (system as { content?: unknown }).content === 'string'
  )
    return (system as { content: string }).content;
  throw new Error('Unexpected system instruction shape.');
}

export function promptObject(call: {
  prompt?: string;
  messages?: { content: { type: string; text: string }[] }[];
}): Record<string, unknown> {
  if (typeof call.prompt === 'string') return JSON.parse(call.prompt) as Record<string, unknown>;
  return Object.assign(
    {},
    ...(call.messages?.[0]?.content ?? []).map((part) => JSON.parse(part.text) as object),
  ) as Record<string, unknown>;
}
