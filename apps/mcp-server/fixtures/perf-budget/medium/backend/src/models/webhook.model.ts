export interface Webhook {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'webhook_active' | 'webhook_inactive';
}

export function isWebhook(value: unknown): value is Webhook {
  return typeof value === 'object' && value !== null && 'id' in value;
}
