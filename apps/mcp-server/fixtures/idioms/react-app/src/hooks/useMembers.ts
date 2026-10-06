import { useQuery } from '@tanstack/react-query';
import { fetchMembers } from '../api/members';

export function useMembers(tenantId: string) {
  return useQuery({
    queryKey: ['members', tenantId],
    queryFn: () => fetchMembers(tenantId),
  });
}
