export async function fetchMembers(tenantId: string) {
  const response = await fetch(`/api/tenants/${tenantId}/members`);
  if (!response.ok) {
    throw new Error('Unable to load members');
  }
  return response.json();
}
