const configuredBase = import.meta.env.VITE_KLAURO_API_URL as string | undefined;
const knownProductionApiHosts: Record<string, string> = {
  'app.klauro.com': 'https://mcp.klauro.com',
};
const fallbackBase = knownProductionApiHosts[window.location.hostname] || window.location.origin;
export const apiBaseUrl = (configuredBase || fallbackBase).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : 'Request failed', response.status);
  }
  return body as T;
}
