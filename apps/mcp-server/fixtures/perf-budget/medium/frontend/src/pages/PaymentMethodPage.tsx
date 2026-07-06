import React from 'react';
import { usePaymentMethods } from '../hooks/usePaymentMethods';
import { PaymentMethodCard } from '../components/PaymentMethodCard';

export function PaymentMethodPage(): JSX.Element {
  const { items, loading } = usePaymentMethods();

  if (loading) {
    return <div>Loading paymentMethods...</div>;
  }

  return (
    <section className="paymentMethod-page">
      <h1>PaymentMethods</h1>
      <div className="paymentMethod-list">
        {items.map((item) => (
          <PaymentMethodCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
