import type { Attachment } from '../types/attachment';

const BASE_URL = '/api/attachments';

export async function fetchAttachments(): Promise<Attachment[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchAttachment(id: string): Promise<Attachment> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createAttachment(payload: Partial<Attachment>): Promise<Attachment> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
