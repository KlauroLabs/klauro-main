export interface Deal {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'deal_active' | 'deal_inactive';
}

export function isDeal(value: unknown): value is Deal {
  return typeof value === 'object' && value !== null && 'id' in value;
}
