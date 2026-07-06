import React from 'react';
import type { Department } from '../types/department';

interface DepartmentCardProps {
  item: Department;
  onSelect?: (id: string) => void;
}

export function DepartmentCard({ item, onSelect }: DepartmentCardProps): JSX.Element {
  return (
    <div className="department-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
