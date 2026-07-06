import { useCallback, useEffect, useState } from 'react';
import { fetchRenewals } from '../api/renewalClient';
import type { Renewal } from '../types/renewal';

export function useRenewals() {
  const [items, setItems] = useState<Renewal[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchRenewals();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
