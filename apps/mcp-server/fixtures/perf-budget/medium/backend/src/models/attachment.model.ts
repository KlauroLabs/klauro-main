export interface Attachment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'attachment_active' | 'attachment_inactive';
}

export function isAttachment(value: unknown): value is Attachment {
  return typeof value === 'object' && value !== null && 'id' in value;
}
