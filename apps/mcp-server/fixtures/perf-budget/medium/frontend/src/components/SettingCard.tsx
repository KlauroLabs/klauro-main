import React from 'react';
import type { Setting } from '../types/setting';

interface SettingCardProps {
  item: Setting;
  onSelect?: (id: string) => void;
}

export function SettingCard({ item, onSelect }: SettingCardProps): JSX.Element {
  return (
    <div className="setting-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
