import type { Tag } from '../types/tag';

const BASE_URL = '/api/tags';

export async function fetchTags(): Promise<Tag[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchTag(id: string): Promise<Tag> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createTag(payload: Partial<Tag>): Promise<Tag> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
