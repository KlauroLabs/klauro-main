import { useCallback, useEffect, useState } from 'react';
import { fetchCompanys } from '../api/companyClient';
import type { Company } from '../types/company';

export function useCompanys() {
  const [items, setItems] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCompanys();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
