import React from 'react';
import type { Shipment } from '../types/shipment';

interface ShipmentCardProps {
  item: Shipment;
  onSelect?: (id: string) => void;
}

export function ShipmentCard({ item, onSelect }: ShipmentCardProps): JSX.Element {
  return (
    <div className="shipment-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
