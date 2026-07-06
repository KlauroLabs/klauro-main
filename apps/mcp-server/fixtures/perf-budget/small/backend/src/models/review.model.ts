export interface Review {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'review_active' | 'review_inactive';
}

export function isReview(value: unknown): value is Review {
  return typeof value === 'object' && value !== null && 'id' in value;
}
