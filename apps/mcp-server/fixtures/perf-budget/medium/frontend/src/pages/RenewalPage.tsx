import React from 'react';
import { useRenewals } from '../hooks/useRenewals';
import { RenewalCard } from '../components/RenewalCard';

export function RenewalPage(): JSX.Element {
  const { items, loading } = useRenewals();

  if (loading) {
    return <div>Loading renewals...</div>;
  }

  return (
    <section className="renewal-page">
      <h1>Renewals</h1>
      <div className="renewal-list">
        {items.map((item) => (
          <RenewalCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
