export async function useOrders(tenantId: string) {
  return fetch(`/api/tenants/${tenantId}/orders`).then(response => response.json());
}
