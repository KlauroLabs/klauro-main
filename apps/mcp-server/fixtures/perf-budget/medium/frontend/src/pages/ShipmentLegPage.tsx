import React from 'react';
import { useShipmentLegs } from '../hooks/useShipmentLegs';
import { ShipmentLegCard } from '../components/ShipmentLegCard';

export function ShipmentLegPage(): JSX.Element {
  const { items, loading } = useShipmentLegs();

  if (loading) {
    return <div>Loading shipmentLegs...</div>;
  }

  return (
    <section className="shipmentLeg-page">
      <h1>ShipmentLegs</h1>
      <div className="shipmentLeg-list">
        {items.map((item) => (
          <ShipmentLegCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
