export interface Attachment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'attachment_active' | 'attachment_inactive';
}
