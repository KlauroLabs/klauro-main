export interface Team {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'team_active' | 'team_inactive';
}
