import { createHash } from 'node:crypto';
import type { Company, ModelOption } from '../../src/shared/types';
import type { Repository } from '../repository';
import { modelRate, providerKey } from './models';
import { PublicError } from '../security';

const cache = new Map<string, { at: number; items: ModelOption[] }>();
export function modelFingerprint(company: Company, credential = ''): string {
  return createHash('sha256').update(JSON.stringify([company.ai.provider, company.ai.model, company.ai.keyMode, company.ai.pricing, credential])).digest('hex');
}
export async function availableModels(repo: Repository, company: Company, refresh = false) {
  if (company.ai.provider === 'mock') return { items: [{ id: 'deterministic-demo', name: 'Local rules (no AI calls)', available: true, priced: true }], checkedAt: new Date().toISOString() };
  const key = await providerKey(repo, company);
  const scope = createHash('sha256').update(`${company.ai.provider}:${key}`).digest('hex');
  let saved = cache.get(scope);
  if (refresh || !saved || Date.now() - saved.at > 3600000) {
    const items: ModelOption[] = [];
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const provider = company.ai.provider;
      const url = new URL(provider === 'openai' ? 'https://api.openai.com/v1/models' : provider === 'anthropic' ? 'https://api.anthropic.com/v1/models' : 'https://generativelanguage.googleapis.com/v1beta/models');
      if (provider === 'gemini') { url.searchParams.set('pageSize', '1000'); if (cursor) url.searchParams.set('pageToken', cursor); }
      if (provider === 'anthropic') { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor); }
      const headers: Record<string,string> = provider === 'openai' ? { Authorization: `Bearer ${key}` } : provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-goog-api-key': key };
      const response = await fetch(url.href, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new PublicError(response.status === 429 ? 'Provider rate limit reached. Retry the model list shortly.' : 'Unable to list models. Check this provider key and permissions.', response.status === 429 ? 429 : 502);
      const data = await response.json() as { data?: { id: string; display_name?: string }[]; models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; has_more?: boolean; last_id?: string; nextPageToken?: string };
      const rows = provider === 'gemini' ? (data.models ?? []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName })) : (data.data ?? []).filter(m => provider !== 'openai' || (/^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(audio|realtime|image|transcrib|tts)/.test(m.id))).map(m => ({ id: m.id, name: m.display_name }));
      for (const row of rows) items.push({ id: row.id, name: row.name || row.id, available: true, priced: false });
      const next = provider === 'gemini' ? data.nextPageToken : provider === 'anthropic' && data.has_more ? data.last_id : undefined;
      if (!next || next === cursor) break;
      if (page === 19) throw new PublicError('Model catalog exceeds the supported page limit. Try again or contact support.', 502);
      cursor = next;
    }
    saved = { at: Date.now(), items: [...new Map(items.map(m => [m.id,m])).values()] };
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(scope, saved);
  }
  const items = saved.items.map(item => {
    try { const [inputRate,outputRate] = modelRate(item.id, item.id === company.ai.model ? company.ai.pricing : undefined); return { ...item, priced: true, inputRate, outputRate }; } catch { return item; }
  });
  if (!items.some(m => m.id === company.ai.model)) items.unshift({ id: company.ai.model, name: `${company.ai.model} (unavailable to this key)`, available: false, priced: false });
  return { items, checkedAt: new Date(saved.at).toISOString() };
}
