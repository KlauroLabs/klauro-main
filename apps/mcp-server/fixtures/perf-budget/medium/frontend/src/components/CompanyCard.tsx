import React from 'react';
import type { Company } from '../types/company';

interface CompanyCardProps {
  item: Company;
  onSelect?: (id: string) => void;
}

export function CompanyCard({ item, onSelect }: CompanyCardProps): JSX.Element {
  return (
    <div className="company-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
