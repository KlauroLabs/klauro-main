import React from 'react';
import type { ApiKey } from '../types/apiKey';

interface ApiKeyCardProps {
  item: ApiKey;
  onSelect?: (id: string) => void;
}

export function ApiKeyCard({ item, onSelect }: ApiKeyCardProps): JSX.Element {
  return (
    <div className="apiKey-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
