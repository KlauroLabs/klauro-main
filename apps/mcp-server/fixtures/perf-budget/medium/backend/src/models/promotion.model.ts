export interface Promotion {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'promotion_active' | 'promotion_inactive';
}

export function isPromotion(value: unknown): value is Promotion {
  return typeof value === 'object' && value !== null && 'id' in value;
}
