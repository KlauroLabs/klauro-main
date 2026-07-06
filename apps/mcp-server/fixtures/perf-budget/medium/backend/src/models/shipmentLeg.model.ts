export interface ShipmentLeg {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'shipmentLeg_active' | 'shipmentLeg_inactive';
}

export function isShipmentLeg(value: unknown): value is ShipmentLeg {
  return typeof value === 'object' && value !== null && 'id' in value;
}
