import { reviewService } from '../services/review.service';

describe('ReviewService', () => {
  it('creates and retrieves a review', async () => {
    const created = await reviewService.create({ name: 'sample-review', status: 'review_active' });
    const fetched = await reviewService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
