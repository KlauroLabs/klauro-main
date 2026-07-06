import React from 'react';
import { useCarts } from '../hooks/useCarts';
import { CartCard } from '../components/CartCard';

export function CartPage(): JSX.Element {
  const { items, loading } = useCarts();

  if (loading) {
    return <div>Loading carts...</div>;
  }

  return (
    <section className="cart-page">
      <h1>Carts</h1>
      <div className="cart-list">
        {items.map((item) => (
          <CartCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
