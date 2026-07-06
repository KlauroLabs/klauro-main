import React from 'react';
import type { Lead } from '../types/lead';

interface LeadCardProps {
  item: Lead;
  onSelect?: (id: string) => void;
}

export function LeadCard({ item, onSelect }: LeadCardProps): JSX.Element {
  return (
    <div className="lead-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
