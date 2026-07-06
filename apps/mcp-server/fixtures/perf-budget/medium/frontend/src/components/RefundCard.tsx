import React from 'react';
import type { Refund } from '../types/refund';

interface RefundCardProps {
  item: Refund;
  onSelect?: (id: string) => void;
}

export function RefundCard({ item, onSelect }: RefundCardProps): JSX.Element {
  return (
    <div className="refund-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
