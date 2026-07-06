export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'task_active' | 'task_inactive';
}
