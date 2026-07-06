import React from 'react';
import type { Team } from '../types/team';

interface TeamCardProps {
  item: Team;
  onSelect?: (id: string) => void;
}

export function TeamCard({ item, onSelect }: TeamCardProps): JSX.Element {
  return (
    <div className="team-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
