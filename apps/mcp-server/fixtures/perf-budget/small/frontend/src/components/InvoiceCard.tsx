import React from 'react';
import type { Invoice } from '../types/invoice';

interface InvoiceCardProps {
  item: Invoice;
  onSelect?: (id: string) => void;
}

export function InvoiceCard({ item, onSelect }: InvoiceCardProps): JSX.Element {
  return (
    <div className="invoice-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
