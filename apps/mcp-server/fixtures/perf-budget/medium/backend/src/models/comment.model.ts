export interface Comment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'comment_active' | 'comment_inactive';
}

export function isComment(value: unknown): value is Comment {
  return typeof value === 'object' && value !== null && 'id' in value;
}
