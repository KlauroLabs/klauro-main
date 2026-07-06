import React from 'react';
import type { Device } from '../types/device';

interface DeviceCardProps {
  item: Device;
  onSelect?: (id: string) => void;
}

export function DeviceCard({ item, onSelect }: DeviceCardProps): JSX.Element {
  return (
    <div className="device-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
