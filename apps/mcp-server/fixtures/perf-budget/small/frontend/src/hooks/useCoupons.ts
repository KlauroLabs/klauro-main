import { useCallback, useEffect, useState } from 'react';
import { fetchCoupons } from '../api/couponClient';
import type { Coupon } from '../types/coupon';

export function useCoupons() {
  const [items, setItems] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCoupons();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
