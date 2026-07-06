import { useCallback, useEffect, useState } from 'react';
import { fetchEmployees } from '../api/employeeClient';
import type { Employee } from '../types/employee';

export function useEmployees() {
  const [items, setItems] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchEmployees();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
