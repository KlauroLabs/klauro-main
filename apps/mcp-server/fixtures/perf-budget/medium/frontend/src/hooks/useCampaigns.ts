import { useCallback, useEffect, useState } from 'react';
import { fetchCampaigns } from '../api/campaignClient';
import type { Campaign } from '../types/campaign';

export function useCampaigns() {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetchCampaigns();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
