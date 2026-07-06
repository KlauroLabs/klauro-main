import { useCallback, useEffect, useState } from 'react';
import { fetchTags } from '../api/tagClient';
import type { Tag } from '../types/tag';

export function useTags() {
  const [items, setItems] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchTags();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
