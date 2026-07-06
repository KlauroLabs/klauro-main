import React from 'react';
import type { Payment } from '../types/payment';

interface PaymentCardProps {
  item: Payment;
  onSelect?: (id: string) => void;
}

export function PaymentCard({ item, onSelect }: PaymentCardProps): JSX.Element {
  return (
    <div className="payment-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
