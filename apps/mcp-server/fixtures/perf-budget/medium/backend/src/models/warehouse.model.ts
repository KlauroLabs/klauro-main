export interface Warehouse {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'warehouse_active' | 'warehouse_inactive';
}

export function isWarehouse(value: unknown): value is Warehouse {
  return typeof value === 'object' && value !== null && 'id' in value;
}
