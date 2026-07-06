import React from 'react';
import { useDeals } from '../hooks/useDeals';
import { DealCard } from '../components/DealCard';

export function DealPage(): JSX.Element {
  const { items, loading } = useDeals();

  if (loading) {
    return <div>Loading deals...</div>;
  }

  return (
    <section className="deal-page">
      <h1>Deals</h1>
      <div className="deal-list">
        {items.map((item) => (
          <DealCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
