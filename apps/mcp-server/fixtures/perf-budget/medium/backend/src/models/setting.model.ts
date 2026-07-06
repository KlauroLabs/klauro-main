export interface Setting {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'setting_active' | 'setting_inactive';
}

export function isSetting(value: unknown): value is Setting {
  return typeof value === 'object' && value !== null && 'id' in value;
}
