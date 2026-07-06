export interface Vendor {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'vendor_active' | 'vendor_inactive';
}

export function isVendor(value: unknown): value is Vendor {
  return typeof value === 'object' && value !== null && 'id' in value;
}
