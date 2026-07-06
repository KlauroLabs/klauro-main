import { useCallback, useEffect, useState } from 'react';
import { fetchTeams } from '../api/teamClient';
import type { Team } from '../types/team';

export function useTeams() {
  const [items, setItems] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchTeams();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
