import React from 'react';
import type { Coupon } from '../types/coupon';

interface CouponCardProps {
  item: Coupon;
  onSelect?: (id: string) => void;
}

export function CouponCard({ item, onSelect }: CouponCardProps): JSX.Element {
  return (
    <div className="coupon-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
