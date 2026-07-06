import React from 'react';
import type { Permission } from '../types/permission';

interface PermissionCardProps {
  item: Permission;
  onSelect?: (id: string) => void;
}

export function PermissionCard({ item, onSelect }: PermissionCardProps): JSX.Element {
  return (
    <div className="permission-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
