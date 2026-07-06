import { useCallback, useEffect, useState } from 'react';
import { fetchSubscriptions } from '../api/subscriptionClient';
import type { Subscription } from '../types/subscription';

export function useSubscriptions() {
  const [items, setItems] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchSubscriptions();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
