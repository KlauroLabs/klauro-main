import React from 'react';
import type { Campaign } from '../types/campaign';

interface CampaignCardProps {
  item: Campaign;
  onSelect?: (id: string) => void;
}

export function CampaignCard({ item, onSelect }: CampaignCardProps): JSX.Element {
  return (
    <div className="campaign-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
