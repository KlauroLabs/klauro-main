import { attachmentService } from '../services/attachment.service';

describe('AttachmentService', () => {
  it('creates and retrieves a attachment', async () => {
    const created = await attachmentService.create({ name: 'sample-attachment', status: 'attachment_active' });
    const fetched = await attachmentService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
