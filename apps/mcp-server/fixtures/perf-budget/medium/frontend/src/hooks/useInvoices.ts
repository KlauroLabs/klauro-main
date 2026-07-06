import { useCallback, useEffect, useState } from 'react';
import { fetchInvoices } from '../api/invoiceClient';
import type { Invoice } from '../types/invoice';

export function useInvoices() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchInvoices();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
