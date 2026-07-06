import React from 'react';
import type { Category } from '../types/category';

interface CategoryCardProps {
  item: Category;
  onSelect?: (id: string) => void;
}

export function CategoryCard({ item, onSelect }: CategoryCardProps): JSX.Element {
  return (
    <div className="category-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
