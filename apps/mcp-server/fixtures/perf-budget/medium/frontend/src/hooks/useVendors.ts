import { useCallback, useEffect, useState } from 'react';
import { fetchVendors } from '../api/vendorClient';
import type { Vendor } from '../types/vendor';

export function useVendors() {
  const [items, setItems] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchVendors();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
