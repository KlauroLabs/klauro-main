import { useCallback, useEffect, useState } from 'react';
import { fetchApiKeys } from '../api/apiKeyClient';
import type { ApiKey } from '../types/apiKey';

export function useApiKeys() {
  const [items, setItems] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchApiKeys();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
