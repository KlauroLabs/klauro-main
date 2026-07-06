import { useCallback, useEffect, useState } from 'react';
import { fetchSessions } from '../api/sessionClient';
import type { Session } from '../types/session';

export function useSessions() {
  const [items, setItems] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchSessions();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
