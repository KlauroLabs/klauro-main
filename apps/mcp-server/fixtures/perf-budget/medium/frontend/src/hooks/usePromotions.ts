import { useCallback, useEffect, useState } from 'react';
import { fetchPromotions } from '../api/promotionClient';
import type { Promotion } from '../types/promotion';

export function usePromotions() {
  const [items, setItems] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchPromotions();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
