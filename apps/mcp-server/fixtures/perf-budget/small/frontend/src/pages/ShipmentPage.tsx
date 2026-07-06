import React from 'react';
import { useShipments } from '../hooks/useShipments';
import { ShipmentCard } from '../components/ShipmentCard';

export function ShipmentPage(): JSX.Element {
  const { items, loading } = useShipments();

  if (loading) {
    return <div>Loading shipments...</div>;
  }

  return (
    <section className="shipment-page">
      <h1>Shipments</h1>
      <div className="shipment-list">
        {items.map((item) => (
          <ShipmentCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
