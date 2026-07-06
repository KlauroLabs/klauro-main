import { useCallback, useEffect, useState } from 'react';
import { fetchShipments } from '../api/shipmentClient';
import type { Shipment } from '../types/shipment';

export function useShipments() {
  const [items, setItems] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchShipments();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
