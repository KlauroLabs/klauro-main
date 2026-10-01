const base = import.meta.env.VITE_API_URL;

export async function apiRequest(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, init);
  return response.json();
}

export function cancelOrder(id: string, token: string) {
  return apiRequest(`/api/orders/${encodeURIComponent(id)}/cancel`, token, { method: 'POST' });
}

export function listOrders(token: string) {
  return apiRequest('/api/orders', token);
}

export function describe(text: string) {
  return text.trim();
}
