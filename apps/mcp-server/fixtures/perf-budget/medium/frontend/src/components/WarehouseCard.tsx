import React from 'react';
import type { Warehouse } from '../types/warehouse';

interface WarehouseCardProps {
  item: Warehouse;
  onSelect?: (id: string) => void;
}

export function WarehouseCard({ item, onSelect }: WarehouseCardProps): JSX.Element {
  return (
    <div className="warehouse-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
