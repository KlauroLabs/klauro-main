import { useCallback, useEffect, useState } from 'react';
import { fetchShipmentLegs } from '../api/shipmentLegClient';
import type { ShipmentLeg } from '../types/shipmentLeg';

export function useShipmentLegs() {
  const [items, setItems] = useState<ShipmentLeg[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchShipmentLegs();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
