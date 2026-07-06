export interface ApiKey {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'apiKey_active' | 'apiKey_inactive';
}

export function isApiKey(value: unknown): value is ApiKey {
  return typeof value === 'object' && value !== null && 'id' in value;
}
