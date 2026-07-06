import { useCallback, useEffect, useState } from 'react';
import { fetchProjects } from '../api/projectClient';
import type { Project } from '../types/project';

export function useProjects() {
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchProjects();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
