import React from 'react';
import type { Role } from '../types/role';

interface RoleCardProps {
  item: Role;
  onSelect?: (id: string) => void;
}

export function RoleCard({ item, onSelect }: RoleCardProps): JSX.Element {
  return (
    <div className="role-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
