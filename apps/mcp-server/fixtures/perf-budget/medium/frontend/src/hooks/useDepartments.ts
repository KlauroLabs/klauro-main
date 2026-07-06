import { useCallback, useEffect, useState } from 'react';
import { fetchDepartments } from '../api/departmentClient';
import type { Department } from '../types/department';

export function useDepartments() {
  const [items, setItems] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchDepartments();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
