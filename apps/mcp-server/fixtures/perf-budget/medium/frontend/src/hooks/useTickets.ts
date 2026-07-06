import { useCallback, useEffect, useState } from 'react';
import { fetchTickets } from '../api/ticketClient';
import type { Ticket } from '../types/ticket';

export function useTickets() {
  const [items, setItems] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchTickets();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
