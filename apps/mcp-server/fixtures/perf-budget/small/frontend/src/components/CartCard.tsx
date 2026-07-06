import React from 'react';
import type { Cart } from '../types/cart';

interface CartCardProps {
  item: Cart;
  onSelect?: (id: string) => void;
}

export function CartCard({ item, onSelect }: CartCardProps): JSX.Element {
  return (
    <div className="cart-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
