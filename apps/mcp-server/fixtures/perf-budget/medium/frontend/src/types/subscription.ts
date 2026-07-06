export interface Subscription {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'subscription_active' | 'subscription_inactive';
}
