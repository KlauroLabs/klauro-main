import React from 'react';
import { useWarehouses } from '../hooks/useWarehouses';
import { WarehouseCard } from '../components/WarehouseCard';

export function WarehousePage(): JSX.Element {
  const { items, loading } = useWarehouses();

  if (loading) {
    return <div>Loading warehouses...</div>;
  }

  return (
    <section className="warehouse-page">
      <h1>Warehouses</h1>
      <div className="warehouse-list">
        {items.map((item) => (
          <WarehouseCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
