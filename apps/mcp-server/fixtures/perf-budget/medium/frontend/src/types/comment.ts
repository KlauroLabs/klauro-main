export interface Comment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'comment_active' | 'comment_inactive';
}
