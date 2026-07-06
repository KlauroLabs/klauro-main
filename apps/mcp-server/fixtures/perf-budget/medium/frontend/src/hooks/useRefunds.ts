import { useCallback, useEffect, useState } from 'react';
import { fetchRefunds } from '../api/refundClient';
import type { Refund } from '../types/refund';

export function useRefunds() {
  const [items, setItems] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchRefunds();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
