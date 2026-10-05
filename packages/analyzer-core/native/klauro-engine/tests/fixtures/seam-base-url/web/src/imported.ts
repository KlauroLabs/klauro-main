import { API_BASE } from './config';

export async function loadOrders() {
  return fetch(`${API_BASE}/orders`);
}
