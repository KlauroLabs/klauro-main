export interface Report {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'report_active' | 'report_inactive';
}

export function isReport(value: unknown): value is Report {
  return typeof value === 'object' && value !== null && 'id' in value;
}
