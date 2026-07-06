import React from 'react';
import type { Promotion } from '../types/promotion';

interface PromotionCardProps {
  item: Promotion;
  onSelect?: (id: string) => void;
}

export function PromotionCard({ item, onSelect }: PromotionCardProps): JSX.Element {
  return (
    <div className="promotion-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
