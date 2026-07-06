export interface Vendor {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'vendor_active' | 'vendor_inactive';
}
