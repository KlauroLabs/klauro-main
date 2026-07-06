export interface Tag {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'tag_active' | 'tag_inactive';
}

export function isTag(value: unknown): value is Tag {
  return typeof value === 'object' && value !== null && 'id' in value;
}
