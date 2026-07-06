import React from 'react';
import type { Report } from '../types/report';

interface ReportCardProps {
  item: Report;
  onSelect?: (id: string) => void;
}

export function ReportCard({ item, onSelect }: ReportCardProps): JSX.Element {
  return (
    <div className="report-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
