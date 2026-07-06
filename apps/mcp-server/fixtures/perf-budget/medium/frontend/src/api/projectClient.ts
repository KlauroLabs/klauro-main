import type { Project } from '../types/project';

const BASE_URL = '/api/projects';

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchProject(id: string): Promise<Project> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createProject(payload: Partial<Project>): Promise<Project> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
