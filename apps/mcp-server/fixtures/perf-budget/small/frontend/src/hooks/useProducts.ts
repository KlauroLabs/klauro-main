import { useCallback, useEffect, useState } from 'react';
import { fetchProducts } from '../api/productClient';
import type { Product } from '../types/product';

export function useProducts() {
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchProducts();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
