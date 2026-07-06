export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'project_active' | 'project_inactive';
}

export function isProject(value: unknown): value is Project {
  return typeof value === 'object' && value !== null && 'id' in value;
}
