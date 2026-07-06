import { useCallback, useEffect, useState } from 'react';
import { fetchContacts } from '../api/contactClient';
import type { Contact } from '../types/contact';

export function useContacts() {
  const [items, setItems] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchContacts();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
