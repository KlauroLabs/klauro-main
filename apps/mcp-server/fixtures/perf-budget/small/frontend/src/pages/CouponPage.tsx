import React from 'react';
import { useCoupons } from '../hooks/useCoupons';
import { CouponCard } from '../components/CouponCard';

export function CouponPage(): JSX.Element {
  const { items, loading } = useCoupons();

  if (loading) {
    return <div>Loading coupons...</div>;
  }

  return (
    <section className="coupon-page">
      <h1>Coupons</h1>
      <div className="coupon-list">
        {items.map((item) => (
          <CouponCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
