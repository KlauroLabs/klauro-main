import { useCallback, useEffect, useState } from 'react';
import { fetchAddresss } from '../api/addressClient';
import type { Address } from '../types/address';

export function useAddresss() {
  const [items, setItems] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchAddresss();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
