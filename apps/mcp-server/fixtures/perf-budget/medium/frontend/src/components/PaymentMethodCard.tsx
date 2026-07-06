import React from 'react';
import type { PaymentMethod } from '../types/paymentMethod';

interface PaymentMethodCardProps {
  item: PaymentMethod;
  onSelect?: (id: string) => void;
}

export function PaymentMethodCard({ item, onSelect }: PaymentMethodCardProps): JSX.Element {
  return (
    <div className="paymentMethod-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
