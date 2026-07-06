import { useCallback, useEffect, useState } from 'react';
import { fetchDeals } from '../api/dealClient';
import type { Deal } from '../types/deal';

export function useDeals() {
  const [items, setItems] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchDeals();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
