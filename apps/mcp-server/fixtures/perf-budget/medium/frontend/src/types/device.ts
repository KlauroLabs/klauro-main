export interface Device {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'device_active' | 'device_inactive';
}
