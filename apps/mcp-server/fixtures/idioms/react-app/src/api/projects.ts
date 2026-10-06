export async function fetchProjects(tenantId: string) {
  const response = await fetch(`/api/tenants/${tenantId}/projects`);
  if (!response.ok) {
    throw new Error('Unable to load projects');
  }
  return response.json();
}
