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

let onSessionRejected: (() => void) | undefined;

export function setAccessToken(value?: string) {
  token = value;
}
/**
 * Called when the backend rejects the sign-in this browser sent (HTTP 401): the session
 * was revoked or ended elsewhere, though it is still saved here.
 */
export function setSessionRejectedHandler(handler?: () => void) {
  onSessionRejected = handler;
}
/** A failed request: the server's message, plus its status, code and body for callers that need them. */
export class ApiError extends Error {
  status: number;
  code?: string;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    const code = (data as { code?: unknown } | null)?.code;
    if (typeof code === 'string') this.code = code;
  }
}
export async function api<T>(
  path: string,
  companyId?: string,
  body?: unknown,
  method?: string,
  init: Pick<RequestInit, 'cache'> = {},
): Promise<T> {
  const sent = token;
  const response = await fetch(`${apiBaseUrl()}/api${path}`, {
    ...init,
    signal: AbortSignal.timeout(45000),
    method: method || (body !== undefined ? 'POST' : 'GET'),
    // Content-Type only with a body: a plain GET then needs no CORS preflight.
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(companyId ? { 'x-company-id': companyId } : {}),
      ...(sent ? { Authorization: `Bearer ${sent}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  // Only when the rejected token is still the current one: a request that raced a token
  // refresh must not sign anyone out.
  if (response.status === 401 && sent && sent === token) onSessionRejected?.();
  if (!response.ok)
    throw new ApiError(
      typeof result.error === 'string'
        ? result.error
        : result.error?.message ||
            result.message ||
            `Request failed (${response.status}). Please try again.`,
      response.status,
      result,
    );
  return result as T;
}
