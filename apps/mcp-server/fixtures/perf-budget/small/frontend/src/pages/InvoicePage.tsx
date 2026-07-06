import React from 'react';
import { useInvoices } from '../hooks/useInvoices';
import { InvoiceCard } from '../components/InvoiceCard';

export function InvoicePage(): JSX.Element {
  const { items, loading } = useInvoices();

  if (loading) {
    return <div>Loading invoices...</div>;
  }

  return (
    <section className="invoice-page">
      <h1>Invoices</h1>
      <div className="invoice-list">
        {items.map((item) => (
          <InvoiceCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
