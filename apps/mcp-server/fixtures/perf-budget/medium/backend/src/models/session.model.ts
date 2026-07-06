export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'session_active' | 'session_inactive';
}

export function isSession(value: unknown): value is Session {
  return typeof value === 'object' && value !== null && 'id' in value;
}
