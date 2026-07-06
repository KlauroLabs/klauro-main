export interface Notification {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'notification_active' | 'notification_inactive';
}

export function isNotification(value: unknown): value is Notification {
  return typeof value === 'object' && value !== null && 'id' in value;
}
