export interface User {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'user_active' | 'user_inactive';
}

export function isUser(value: unknown): value is User {
  return typeof value === 'object' && value !== null && 'id' in value;
}
