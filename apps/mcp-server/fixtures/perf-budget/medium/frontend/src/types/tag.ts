export interface Tag {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'tag_active' | 'tag_inactive';
}
