export function disconnectPolicy(code: number): 'logout' | 'stop' | 'restart' | 'retry' {
  if (code === 401) return 'logout';
  if (code === 515) return 'restart';
  if ([408, 428, 503].includes(code)) return 'retry';
  return 'stop'; // Includes 403, 411, 440, 500 and unknown failures.
}
export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.min(60000, 1000 * 2 ** Math.max(0, attempt - 1)) * (0.75 + random * 0.5);
}
export function canonicalJid(value?: string | null): string | undefined {
  const match = value?.match(/^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/);
  return match ? `${match[1]}@${match[2]}` : undefined;
}
export function phoneFromJid(value?: string): string | undefined {
  const jid = canonicalJid(value);
  return jid?.endsWith('@s.whatsapp.net') && /^[1-9]\d{5,14}@/.test(jid)
    ? `+${jid.split('@')[0]}`
    : undefined;
}
