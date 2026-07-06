import React from 'react';
import type { Quote } from '../types/quote';

interface QuoteCardProps {
  item: Quote;
  onSelect?: (id: string) => void;
}

export function QuoteCard({ item, onSelect }: QuoteCardProps): JSX.Element {
  return (
    <div className="quote-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
