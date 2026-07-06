import React from 'react';
import type { Product } from '../types/product';

interface ProductCardProps {
  item: Product;
  onSelect?: (id: string) => void;
}

export function ProductCard({ item, onSelect }: ProductCardProps): JSX.Element {
  return (
    <div className="product-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
