import React from 'react';
import type { Tag } from '../types/tag';

interface TagCardProps {
  item: Tag;
  onSelect?: (id: string) => void;
}

export function TagCard({ item, onSelect }: TagCardProps): JSX.Element {
  return (
    <div className="tag-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
