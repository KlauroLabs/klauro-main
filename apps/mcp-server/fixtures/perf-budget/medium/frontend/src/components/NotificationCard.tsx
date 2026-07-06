import React from 'react';
import type { Notification } from '../types/notification';

interface NotificationCardProps {
  item: Notification;
  onSelect?: (id: string) => void;
}

export function NotificationCard({ item, onSelect }: NotificationCardProps): JSX.Element {
  return (
    <div className="notification-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
