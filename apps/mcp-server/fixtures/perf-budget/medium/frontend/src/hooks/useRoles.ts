import { useCallback, useEffect, useState } from 'react';
import { fetchRoles } from '../api/roleClient';
import type { Role } from '../types/role';

export function useRoles() {
  const [items, setItems] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchRoles();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
