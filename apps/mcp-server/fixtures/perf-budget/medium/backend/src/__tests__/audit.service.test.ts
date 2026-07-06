import { auditService } from '../services/audit.service';

describe('AuditService', () => {
  it('creates and retrieves a audit', async () => {
    const created = await auditService.create({ name: 'sample-audit', status: 'audit_active' });
    const fetched = await auditService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
