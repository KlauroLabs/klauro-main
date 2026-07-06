import React from 'react';
import type { Subscription } from '../types/subscription';

interface SubscriptionCardProps {
  item: Subscription;
  onSelect?: (id: string) => void;
}

export function SubscriptionCard({ item, onSelect }: SubscriptionCardProps): JSX.Element {
  return (
    <div className="subscription-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
