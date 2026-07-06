import { useCallback, useEffect, useState } from 'react';
import { fetchInvoiceLines } from '../api/invoiceLineClient';
import type { InvoiceLine } from '../types/invoiceLine';

export function useInvoiceLines() {
  const [items, setItems] = useState<InvoiceLine[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchInvoiceLines();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
