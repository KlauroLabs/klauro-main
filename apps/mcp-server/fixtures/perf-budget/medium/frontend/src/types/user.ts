export interface User {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'user_active' | 'user_inactive';
}
