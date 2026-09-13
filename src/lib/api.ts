let token: string | undefined;

function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!configured) return '';

  const invalid = () =>
    new Error(
      'VITE_API_BASE_URL must be an absolute HTTPS backend URL (HTTP is allowed only for localhost), without credentials, a query, or a fragment.',
    );
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalid();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !/^https?:\/\//i.test(configured) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid();

  return url.href.replace(/\/+$/, '');
}

export function setAccessToken(value?: string) {
  token = value;
}
export async function api<T>(
  path: string,
  companyId?: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(companyId ? { 'x-company-id': companyId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? result.error
        : result.error?.message ||
            result.message ||
            `Request failed (${response.status}). Please try again.`,
    );
  return result as T;
}
