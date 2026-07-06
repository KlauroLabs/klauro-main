import type { Report } from '../types/report';

const BASE_URL = '/api/reports';

export async function fetchReports(): Promise<Report[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchReport(id: string): Promise<Report> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createReport(payload: Partial<Report>): Promise<Report> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
