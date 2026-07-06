import type { ShipmentLeg } from '../types/shipmentLeg';

const BASE_URL = '/api/shipmentLegs';

export async function fetchShipmentLegs(): Promise<ShipmentLeg[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchShipmentLeg(id: string): Promise<ShipmentLeg> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createShipmentLeg(payload: Partial<ShipmentLeg>): Promise<ShipmentLeg> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
