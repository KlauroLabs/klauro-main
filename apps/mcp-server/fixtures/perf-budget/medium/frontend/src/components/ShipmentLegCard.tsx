import React from 'react';
import type { ShipmentLeg } from '../types/shipmentLeg';

interface ShipmentLegCardProps {
  item: ShipmentLeg;
  onSelect?: (id: string) => void;
}

export function ShipmentLegCard({ item, onSelect }: ShipmentLegCardProps): JSX.Element {
  return (
    <div className="shipmentLeg-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
