export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'session_active' | 'session_inactive';
}
