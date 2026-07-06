export interface Shipment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'shipment_active' | 'shipment_inactive';
}
