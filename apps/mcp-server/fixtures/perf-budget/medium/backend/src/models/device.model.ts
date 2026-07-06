export interface Device {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'device_active' | 'device_inactive';
}

export function isDevice(value: unknown): value is Device {
  return typeof value === 'object' && value !== null && 'id' in value;
}
