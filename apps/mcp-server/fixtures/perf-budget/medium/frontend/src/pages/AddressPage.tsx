import React from 'react';
import { useAddresss } from '../hooks/useAddresss';
import { AddressCard } from '../components/AddressCard';

export function AddressPage(): JSX.Element {
  const { items, loading } = useAddresss();

  if (loading) {
    return <div>Loading addresss...</div>;
  }

  return (
    <section className="address-page">
      <h1>Addresss</h1>
      <div className="address-list">
        {items.map((item) => (
          <AddressCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
