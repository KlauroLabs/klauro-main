import { useCallback, useEffect, useState } from 'react';
import { fetchCustomers } from '../api/customerClient';
import type { Customer } from '../types/customer';

export function useCustomers() {
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCustomers();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
