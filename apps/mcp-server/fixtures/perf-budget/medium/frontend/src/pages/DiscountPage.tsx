import React from 'react';
import { useDiscounts } from '../hooks/useDiscounts';
import { DiscountCard } from '../components/DiscountCard';

export function DiscountPage(): JSX.Element {
  const { items, loading } = useDiscounts();

  if (loading) {
    return <div>Loading discounts...</div>;
  }

  return (
    <section className="discount-page">
      <h1>Discounts</h1>
      <div className="discount-list">
        {items.map((item) => (
          <DiscountCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
