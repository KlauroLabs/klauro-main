import { useCallback, useEffect, useState } from 'react';
import { fetchPayments } from '../api/paymentClient';
import type { Payment } from '../types/payment';

export function usePayments() {
  const [items, setItems] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchPayments();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
