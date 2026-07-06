export interface Setting {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'setting_active' | 'setting_inactive';
}
