import { useQuery } from '@tanstack/react-query';
import { fetchTenant } from '../api/tenants';

export function useTenant(tenantId: string) {
  return useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => fetchTenant(tenantId),
  });
}
