import React from 'react';
import { useCampaigns } from '../hooks/useCampaigns';
import { CampaignCard } from '../components/CampaignCard';

export function CampaignPage(): JSX.Element {
  const { items, loading } = useCampaigns();

  if (loading) {
    return <div>Loading campaigns...</div>;
  }

  return (
    <section className="campaign-page">
      <h1>Campaigns</h1>
      <div className="campaign-list">
        {items.map((item) => (
          <CampaignCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
