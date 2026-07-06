export interface Notification {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'notification_active' | 'notification_inactive';
}
