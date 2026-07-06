export interface Project {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'project_active' | 'project_inactive';
}
