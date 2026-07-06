import React from 'react';
import type { Audit } from '../types/audit';

interface AuditCardProps {
  item: Audit;
  onSelect?: (id: string) => void;
}

export function AuditCard({ item, onSelect }: AuditCardProps): JSX.Element {
  return (
    <div className="audit-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
