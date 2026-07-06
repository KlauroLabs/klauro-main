export interface Category {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'category_active' | 'category_inactive';
}

export function isCategory(value: unknown): value is Category {
  return typeof value === 'object' && value !== null && 'id' in value;
}
