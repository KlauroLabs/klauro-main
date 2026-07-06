import React from 'react';
import { useSubscriptions } from '../hooks/useSubscriptions';
import { SubscriptionCard } from '../components/SubscriptionCard';

export function SubscriptionPage(): JSX.Element {
  const { items, loading } = useSubscriptions();

  if (loading) {
    return <div>Loading subscriptions...</div>;
  }

  return (
    <section className="subscription-page">
      <h1>Subscriptions</h1>
      <div className="subscription-list">
        {items.map((item) => (
          <SubscriptionCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
