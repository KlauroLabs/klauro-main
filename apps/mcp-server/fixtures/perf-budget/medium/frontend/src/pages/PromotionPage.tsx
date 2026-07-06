import React from 'react';
import { usePromotions } from '../hooks/usePromotions';
import { PromotionCard } from '../components/PromotionCard';

export function PromotionPage(): JSX.Element {
  const { items, loading } = usePromotions();

  if (loading) {
    return <div>Loading promotions...</div>;
  }

  return (
    <section className="promotion-page">
      <h1>Promotions</h1>
      <div className="promotion-list">
        {items.map((item) => (
          <PromotionCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
