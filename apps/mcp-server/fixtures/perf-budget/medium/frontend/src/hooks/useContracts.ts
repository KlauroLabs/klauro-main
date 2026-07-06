import { useCallback, useEffect, useState } from 'react';
import { fetchContracts } from '../api/contractClient';
import type { Contract } from '../types/contract';

export function useContracts() {
  const [items, setItems] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchContracts();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
