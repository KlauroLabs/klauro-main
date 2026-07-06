import type { Department } from '../types/department';

const BASE_URL = '/api/departments';

export async function fetchDepartments(): Promise<Department[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchDepartment(id: string): Promise<Department> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createDepartment(payload: Partial<Department>): Promise<Department> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
