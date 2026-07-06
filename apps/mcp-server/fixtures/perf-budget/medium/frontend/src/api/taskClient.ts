import type { Task } from '../types/task';

const BASE_URL = '/api/tasks';

export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchTask(id: string): Promise<Task> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createTask(payload: Partial<Task>): Promise<Task> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
