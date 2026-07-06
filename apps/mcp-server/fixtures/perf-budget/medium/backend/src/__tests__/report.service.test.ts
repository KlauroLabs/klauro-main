import { reportService } from '../services/report.service';

describe('ReportService', () => {
  it('creates and retrieves a report', async () => {
    const created = await reportService.create({ name: 'sample-report', status: 'report_active' });
    const fetched = await reportService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
