import React from 'react';
import type { Discount } from '../types/discount';

interface DiscountCardProps {
  item: Discount;
  onSelect?: (id: string) => void;
}

export function DiscountCard({ item, onSelect }: DiscountCardProps): JSX.Element {
  return (
    <div className="discount-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
