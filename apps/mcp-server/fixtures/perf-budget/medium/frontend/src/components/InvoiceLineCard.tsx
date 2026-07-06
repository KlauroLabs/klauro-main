import React from 'react';
import type { InvoiceLine } from '../types/invoiceLine';

interface InvoiceLineCardProps {
  item: InvoiceLine;
  onSelect?: (id: string) => void;
}

export function InvoiceLineCard({ item, onSelect }: InvoiceLineCardProps): JSX.Element {
  return (
    <div className="invoiceLine-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
