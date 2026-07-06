import React from 'react';
import { usePayments } from '../hooks/usePayments';
import { PaymentCard } from '../components/PaymentCard';

export function PaymentPage(): JSX.Element {
  const { items, loading } = usePayments();

  if (loading) {
    return <div>Loading payments...</div>;
  }

  return (
    <section className="payment-page">
      <h1>Payments</h1>
      <div className="payment-list">
        {items.map((item) => (
          <PaymentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
