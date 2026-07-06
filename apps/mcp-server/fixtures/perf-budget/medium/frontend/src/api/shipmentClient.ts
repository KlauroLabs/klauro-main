import type { Shipment } from '../types/shipment';

const BASE_URL = '/api/shipments';

export async function fetchShipments(): Promise<Shipment[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchShipment(id: string): Promise<Shipment> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createShipment(payload: Partial<Shipment>): Promise<Shipment> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
