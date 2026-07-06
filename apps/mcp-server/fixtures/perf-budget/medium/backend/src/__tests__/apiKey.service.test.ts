import { apiKeyService } from '../services/apiKey.service';

describe('ApiKeyService', () => {
  it('creates and retrieves a apiKey', async () => {
    const created = await apiKeyService.create({ name: 'sample-apiKey', status: 'apiKey_active' });
    const fetched = await apiKeyService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
