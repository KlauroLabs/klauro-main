import React from 'react';
import type { Review } from '../types/review';

interface ReviewCardProps {
  item: Review;
  onSelect?: (id: string) => void;
}

export function ReviewCard({ item, onSelect }: ReviewCardProps): JSX.Element {
  return (
    <div className="review-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
