import { contactService } from '../services/contact.service';

describe('ContactService', () => {
  it('creates and retrieves a contact', async () => {
    const created = await contactService.create({ name: 'sample-contact', status: 'contact_active' });
    const fetched = await contactService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
