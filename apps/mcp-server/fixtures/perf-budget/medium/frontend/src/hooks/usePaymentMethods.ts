import { useCallback, useEffect, useState } from 'react';
import { fetchPaymentMethods } from '../api/paymentMethodClient';
import type { PaymentMethod } from '../types/paymentMethod';

export function usePaymentMethods() {
  const [items, setItems] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchPaymentMethods();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
