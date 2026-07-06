import type { Device } from '../types/device';

const BASE_URL = '/api/devices';

export async function fetchDevices(): Promise<Device[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchDevice(id: string): Promise<Device> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createDevice(payload: Partial<Device>): Promise<Device> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
