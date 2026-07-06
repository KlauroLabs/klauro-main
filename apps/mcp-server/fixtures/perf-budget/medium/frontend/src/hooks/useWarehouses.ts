import { useCallback, useEffect, useState } from 'react';
import { fetchWarehouses } from '../api/warehouseClient';
import type { Warehouse } from '../types/warehouse';

export function useWarehouses() {
  const [items, setItems] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchWarehouses();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
