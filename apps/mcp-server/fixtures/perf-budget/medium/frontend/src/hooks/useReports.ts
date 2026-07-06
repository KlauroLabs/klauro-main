import { useCallback, useEffect, useState } from 'react';
import { fetchReports } from '../api/reportClient';
import type { Report } from '../types/report';

export function useReports() {
  const [items, setItems] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchReports();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
