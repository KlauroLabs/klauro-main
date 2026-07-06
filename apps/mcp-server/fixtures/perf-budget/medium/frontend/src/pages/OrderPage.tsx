import React from 'react';
import { useOrders } from '../hooks/useOrders';
import { OrderCard } from '../components/OrderCard';

export function OrderPage(): JSX.Element {
  const { items, loading } = useOrders();

  if (loading) {
    return <div>Loading orders...</div>;
  }

  return (
    <section className="order-page">
      <h1>Orders</h1>
      <div className="order-list">
        {items.map((item) => (
          <OrderCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
