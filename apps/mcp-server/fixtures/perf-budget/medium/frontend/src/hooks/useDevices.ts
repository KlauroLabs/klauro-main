import { useCallback, useEffect, useState } from 'react';
import { fetchDevices } from '../api/deviceClient';
import type { Device } from '../types/device';

export function useDevices() {
  const [items, setItems] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchDevices();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
