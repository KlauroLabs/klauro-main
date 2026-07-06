export interface Review {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'review_active' | 'review_inactive';
}
