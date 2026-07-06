import React from 'react';
import { useRefunds } from '../hooks/useRefunds';
import { RefundCard } from '../components/RefundCard';

export function RefundPage(): JSX.Element {
  const { items, loading } = useRefunds();

  if (loading) {
    return <div>Loading refunds...</div>;
  }

  return (
    <section className="refund-page">
      <h1>Refunds</h1>
      <div className="refund-list">
        {items.map((item) => (
          <RefundCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
