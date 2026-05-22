export async function fetchUsers(tenantId: string) {
  const response = await fetch(`/api/tenants/${tenantId}/users`);
  if (!response.ok) {
    throw new Error('Unable to load users');
  }
  return response.json();
}
