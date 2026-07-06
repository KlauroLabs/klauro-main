import { useCallback, useEffect, useState } from 'react';
import { fetchDiscounts } from '../api/discountClient';
import type { Discount } from '../types/discount';

export function useDiscounts() {
  const [items, setItems] = useState<Discount[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchDiscounts();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
