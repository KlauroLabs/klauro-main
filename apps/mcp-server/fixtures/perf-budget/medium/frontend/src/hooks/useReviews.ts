import { useCallback, useEffect, useState } from 'react';
import { fetchReviews } from '../api/reviewClient';
import type { Review } from '../types/review';

export function useReviews() {
  const [items, setItems] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchReviews();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
