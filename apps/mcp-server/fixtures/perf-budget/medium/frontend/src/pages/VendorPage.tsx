import React from 'react';
import { useVendors } from '../hooks/useVendors';
import { VendorCard } from '../components/VendorCard';

export function VendorPage(): JSX.Element {
  const { items, loading } = useVendors();

  if (loading) {
    return <div>Loading vendors...</div>;
  }

  return (
    <section className="vendor-page">
      <h1>Vendors</h1>
      <div className="vendor-list">
        {items.map((item) => (
          <VendorCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
