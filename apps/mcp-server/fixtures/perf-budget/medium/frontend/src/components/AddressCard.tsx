import React from 'react';
import type { Address } from '../types/address';

interface AddressCardProps {
  item: Address;
  onSelect?: (id: string) => void;
}

export function AddressCard({ item, onSelect }: AddressCardProps): JSX.Element {
  return (
    <div className="address-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
