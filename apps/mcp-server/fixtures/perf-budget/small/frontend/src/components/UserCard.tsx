import React from 'react';
import type { User } from '../types/user';

interface UserCardProps {
  item: User;
  onSelect?: (id: string) => void;
}

export function UserCard({ item, onSelect }: UserCardProps): JSX.Element {
  return (
    <div className="user-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
