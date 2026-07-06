import { useCallback, useEffect, useState } from 'react';
import { fetchCategorys } from '../api/categoryClient';
import type { Category } from '../types/category';

export function useCategorys() {
  const [items, setItems] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCategorys();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
