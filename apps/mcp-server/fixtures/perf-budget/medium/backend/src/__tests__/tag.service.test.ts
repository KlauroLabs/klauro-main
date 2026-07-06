import { tagService } from '../services/tag.service';

describe('TagService', () => {
  it('creates and retrieves a tag', async () => {
    const created = await tagService.create({ name: 'sample-tag', status: 'tag_active' });
    const fetched = await tagService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
