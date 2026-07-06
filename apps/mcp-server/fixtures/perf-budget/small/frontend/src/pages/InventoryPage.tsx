import React from 'react';
import { useInventorys } from '../hooks/useInventorys';
import { InventoryCard } from '../components/InventoryCard';

export function InventoryPage(): JSX.Element {
  const { items, loading } = useInventorys();

  if (loading) {
    return <div>Loading inventorys...</div>;
  }

  return (
    <section className="inventory-page">
      <h1>Inventorys</h1>
      <div className="inventory-list">
        {items.map((item) => (
          <InventoryCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
