export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'task_active' | 'task_inactive';
}

export function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && 'id' in value;
}
