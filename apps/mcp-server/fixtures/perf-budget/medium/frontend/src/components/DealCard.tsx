import React from 'react';
import type { Deal } from '../types/deal';

interface DealCardProps {
  item: Deal;
  onSelect?: (id: string) => void;
}

export function DealCard({ item, onSelect }: DealCardProps): JSX.Element {
  return (
    <div className="deal-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
