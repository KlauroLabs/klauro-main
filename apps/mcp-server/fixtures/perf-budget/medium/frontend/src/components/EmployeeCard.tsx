import React from 'react';
import type { Employee } from '../types/employee';

interface EmployeeCardProps {
  item: Employee;
  onSelect?: (id: string) => void;
}

export function EmployeeCard({ item, onSelect }: EmployeeCardProps): JSX.Element {
  return (
    <div className="employee-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
