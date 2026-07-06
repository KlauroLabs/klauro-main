import { useCallback, useEffect, useState } from 'react';
import { fetchPermissions } from '../api/permissionClient';
import type { Permission } from '../types/permission';

export function usePermissions() {
  const [items, setItems] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchPermissions();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
