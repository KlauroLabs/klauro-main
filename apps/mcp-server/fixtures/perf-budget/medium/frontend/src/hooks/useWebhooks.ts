import { useCallback, useEffect, useState } from 'react';
import { fetchWebhooks } from '../api/webhookClient';
import type { Webhook } from '../types/webhook';

export function useWebhooks() {
  const [items, setItems] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchWebhooks();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
