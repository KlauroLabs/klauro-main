import React from 'react';
import { useCustomers } from '../hooks/useCustomers';
import { CustomerCard } from '../components/CustomerCard';

export function CustomerPage(): JSX.Element {
  const { items, loading } = useCustomers();

  if (loading) {
    return <div>Loading customers...</div>;
  }

  return (
    <section className="customer-page">
      <h1>Customers</h1>
      <div className="customer-list">
        {items.map((item) => (
          <CustomerCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
