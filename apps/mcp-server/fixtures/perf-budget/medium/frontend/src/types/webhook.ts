export interface Webhook {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'webhook_active' | 'webhook_inactive';
}
