let token: string | undefined;
export function setAccessToken(value?: string) {
  token = value;
}
export async function api<T>(
  path: string,
  companyId?: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
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
