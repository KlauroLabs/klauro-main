import React from 'react';
import { useInvoiceLines } from '../hooks/useInvoiceLines';
import { InvoiceLineCard } from '../components/InvoiceLineCard';

export function InvoiceLinePage(): JSX.Element {
  const { items, loading } = useInvoiceLines();

  if (loading) {
    return <div>Loading invoiceLines...</div>;
  }

  return (
    <section className="invoiceLine-page">
      <h1>InvoiceLines</h1>
      <div className="invoiceLine-list">
        {items.map((item) => (
          <InvoiceLineCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
