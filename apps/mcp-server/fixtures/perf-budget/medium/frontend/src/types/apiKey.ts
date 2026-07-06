export interface ApiKey {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'apiKey_active' | 'apiKey_inactive';
}
