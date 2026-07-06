import React from 'react';
import type { Order } from '../types/order';

interface OrderCardProps {
  item: Order;
  onSelect?: (id: string) => void;
}

export function OrderCard({ item, onSelect }: OrderCardProps): JSX.Element {
  return (
    <div className="order-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
