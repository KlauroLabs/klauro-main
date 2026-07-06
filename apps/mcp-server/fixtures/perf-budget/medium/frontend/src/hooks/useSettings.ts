import { useCallback, useEffect, useState } from 'react';
import { fetchSettings } from '../api/settingClient';
import type { Setting } from '../types/setting';

export function useSettings() {
  const [items, setItems] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchSettings();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
