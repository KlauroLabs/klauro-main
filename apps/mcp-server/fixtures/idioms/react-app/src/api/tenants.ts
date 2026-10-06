export async function fetchTenant(tenantId: string) {
  const response = await fetch(`/api/tenants/${tenantId}`);
  if (!response.ok) {
    throw new Error('Unable to load tenant');
  }
  return response.json();
}
