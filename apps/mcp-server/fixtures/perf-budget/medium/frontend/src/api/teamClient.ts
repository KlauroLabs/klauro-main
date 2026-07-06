import type { Team } from '../types/team';

const BASE_URL = '/api/teams';

export async function fetchTeams(): Promise<Team[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchTeam(id: string): Promise<Team> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createTeam(payload: Partial<Team>): Promise<Team> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
