export async function createsAnOrder() {
  return fetch('/api/orders', { method: 'POST' });
}
