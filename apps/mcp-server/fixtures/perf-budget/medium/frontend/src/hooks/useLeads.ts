import { useCallback, useEffect, useState } from 'react';
import { fetchLeads } from '../api/leadClient';
import type { Lead } from '../types/lead';

export function useLeads() {
  const [items, setItems] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchLeads();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
