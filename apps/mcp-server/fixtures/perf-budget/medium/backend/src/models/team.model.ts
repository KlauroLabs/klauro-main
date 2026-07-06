export interface Team {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'team_active' | 'team_inactive';
}

export function isTeam(value: unknown): value is Team {
  return typeof value === 'object' && value !== null && 'id' in value;
}
