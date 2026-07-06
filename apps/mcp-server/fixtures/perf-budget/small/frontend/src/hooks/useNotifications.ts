import { useCallback, useEffect, useState } from 'react';
import { fetchNotifications } from '../api/notificationClient';
import type { Notification } from '../types/notification';

export function useNotifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchNotifications();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
