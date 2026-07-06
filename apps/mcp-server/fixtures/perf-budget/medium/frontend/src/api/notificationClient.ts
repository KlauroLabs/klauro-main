import type { Notification } from '../types/notification';

const BASE_URL = '/api/notifications';

export async function fetchNotifications(): Promise<Notification[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchNotification(id: string): Promise<Notification> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createNotification(payload: Partial<Notification>): Promise<Notification> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
