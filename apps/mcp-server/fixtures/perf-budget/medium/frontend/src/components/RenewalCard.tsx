import React from 'react';
import type { Renewal } from '../types/renewal';

interface RenewalCardProps {
  item: Renewal;
  onSelect?: (id: string) => void;
}

export function RenewalCard({ item, onSelect }: RenewalCardProps): JSX.Element {
  return (
    <div className="renewal-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
