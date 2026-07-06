import type { Employee } from '../types/employee';

const BASE_URL = '/api/employees';

export async function fetchEmployees(): Promise<Employee[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchEmployee(id: string): Promise<Employee> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createEmployee(payload: Partial<Employee>): Promise<Employee> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
