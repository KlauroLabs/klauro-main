import { useQuery } from '@tanstack/react-query';
import { fetchUsers } from '../api/users';

export function useUsers(tenantId: string) {
  return useQuery({
    queryKey: ['users', tenantId],
    queryFn: () => fetchUsers(tenantId),
  });
}
