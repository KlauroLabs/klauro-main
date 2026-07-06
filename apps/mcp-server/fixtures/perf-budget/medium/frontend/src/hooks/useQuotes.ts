import { useCallback, useEffect, useState } from 'react';
import { fetchQuotes } from '../api/quoteClient';
import type { Quote } from '../types/quote';

export function useQuotes() {
  const [items, setItems] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchQuotes();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
