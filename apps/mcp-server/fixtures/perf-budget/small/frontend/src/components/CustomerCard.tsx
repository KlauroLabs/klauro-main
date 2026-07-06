import React from 'react';
import type { Customer } from '../types/customer';

interface CustomerCardProps {
  item: Customer;
  onSelect?: (id: string) => void;
}

export function CustomerCard({ item, onSelect }: CustomerCardProps): JSX.Element {
  return (
    <div className="customer-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
