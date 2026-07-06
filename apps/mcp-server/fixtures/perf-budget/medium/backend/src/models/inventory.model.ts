export interface Inventory {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'inventory_active' | 'inventory_inactive';
}

export function isInventory(value: unknown): value is Inventory {
  return typeof value === 'object' && value !== null && 'id' in value;
}
