import React from 'react';
import type { Inventory } from '../types/inventory';

interface InventoryCardProps {
  item: Inventory;
  onSelect?: (id: string) => void;
}

export function InventoryCard({ item, onSelect }: InventoryCardProps): JSX.Element {
  return (
    <div className="inventory-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
