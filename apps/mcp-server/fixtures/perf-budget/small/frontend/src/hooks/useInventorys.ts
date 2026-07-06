import { useCallback, useEffect, useState } from 'react';
import { fetchInventorys } from '../api/inventoryClient';
import type { Inventory } from '../types/inventory';

export function useInventorys() {
  const [items, setItems] = useState<Inventory[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchInventorys();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
