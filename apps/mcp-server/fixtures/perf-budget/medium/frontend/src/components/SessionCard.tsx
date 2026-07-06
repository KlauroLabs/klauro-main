import React from 'react';
import type { Session } from '../types/session';

interface SessionCardProps {
  item: Session;
  onSelect?: (id: string) => void;
}

export function SessionCard({ item, onSelect }: SessionCardProps): JSX.Element {
  return (
    <div className="session-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
