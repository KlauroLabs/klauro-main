export interface Subscription {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'subscription_active' | 'subscription_inactive';
}

export function isSubscription(value: unknown): value is Subscription {
  return typeof value === 'object' && value !== null && 'id' in value;
}
