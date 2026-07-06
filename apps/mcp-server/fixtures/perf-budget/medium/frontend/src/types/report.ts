export interface Report {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'report_active' | 'report_inactive';
}
