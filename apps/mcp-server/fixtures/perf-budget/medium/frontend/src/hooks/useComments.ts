import { useCallback, useEffect, useState } from 'react';
import { fetchComments } from '../api/commentClient';
import type { Comment } from '../types/comment';

export function useComments() {
  const [items, setItems] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchComments();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
