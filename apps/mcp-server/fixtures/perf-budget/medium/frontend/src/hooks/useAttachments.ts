import { useCallback, useEffect, useState } from 'react';
import { fetchAttachments } from '../api/attachmentClient';
import type { Attachment } from '../types/attachment';

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchAttachments();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
