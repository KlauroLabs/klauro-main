import { useCallback, useEffect, useState } from 'react';
import { fetchAudits } from '../api/auditClient';
import type { Audit } from '../types/audit';

export function useAudits() {
  const [items, setItems] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchAudits();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
