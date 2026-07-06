export interface Warehouse {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'warehouse_active' | 'warehouse_inactive';
}
