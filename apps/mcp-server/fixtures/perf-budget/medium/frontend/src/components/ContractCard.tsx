import React from 'react';
import type { Contract } from '../types/contract';

interface ContractCardProps {
  item: Contract;
  onSelect?: (id: string) => void;
}

export function ContractCard({ item, onSelect }: ContractCardProps): JSX.Element {
  return (
    <div className="contract-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
