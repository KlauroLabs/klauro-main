export interface ShipmentLeg {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'shipmentLeg_active' | 'shipmentLeg_inactive';
}
