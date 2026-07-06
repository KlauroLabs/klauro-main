import { useCallback, useEffect, useState } from 'react';
import { fetchCarts } from '../api/cartClient';
import type { Cart } from '../types/cart';

export function useCarts() {
  const [items, setItems] = useState<Cart[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCarts();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
