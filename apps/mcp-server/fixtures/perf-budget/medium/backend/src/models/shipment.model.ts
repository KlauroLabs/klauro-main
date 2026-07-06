export interface Shipment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'shipment_active' | 'shipment_inactive';
}

export function isShipment(value: unknown): value is Shipment {
  return typeof value === 'object' && value !== null && 'id' in value;
}
