import { useCallback, useEffect, useState } from 'react';
import { fetchOrders } from '../api/orderClient';
import type { Order } from '../types/order';

export function useOrders() {
  const [items, setItems] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchOrders();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
