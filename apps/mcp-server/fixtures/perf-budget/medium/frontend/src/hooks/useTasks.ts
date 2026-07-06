import { useCallback, useEffect, useState } from 'react';
import { fetchTasks } from '../api/taskClient';
import type { Task } from '../types/task';

export function useTasks() {
  const [items, setItems] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchTasks();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
