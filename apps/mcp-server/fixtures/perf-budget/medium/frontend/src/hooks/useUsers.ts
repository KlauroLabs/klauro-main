import { useCallback, useEffect, useState } from 'react';
import { fetchUsers } from '../api/userClient';
import type { User } from '../types/user';

export function useUsers() {
  const [items, setItems] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchUsers();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
