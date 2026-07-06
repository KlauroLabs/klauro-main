import React from 'react';
import type { Webhook } from '../types/webhook';

interface WebhookCardProps {
  item: Webhook;
  onSelect?: (id: string) => void;
}

export function WebhookCard({ item, onSelect }: WebhookCardProps): JSX.Element {
  return (
    <div className="webhook-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
