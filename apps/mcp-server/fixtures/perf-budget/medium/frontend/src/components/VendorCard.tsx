import React from 'react';
import type { Vendor } from '../types/vendor';

interface VendorCardProps {
  item: Vendor;
  onSelect?: (id: string) => void;
}

export function VendorCard({ item, onSelect }: VendorCardProps): JSX.Element {
  return (
    <div className="vendor-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
