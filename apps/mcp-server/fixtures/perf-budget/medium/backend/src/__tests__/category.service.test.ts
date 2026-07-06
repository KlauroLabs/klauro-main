import { categoryService } from '../services/category.service';

describe('CategoryService', () => {
  it('creates and retrieves a category', async () => {
    const created = await categoryService.create({ name: 'sample-category', status: 'category_active' });
    const fetched = await categoryService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
