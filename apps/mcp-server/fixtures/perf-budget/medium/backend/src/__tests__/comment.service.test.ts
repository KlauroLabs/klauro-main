import { commentService } from '../services/comment.service';

describe('CommentService', () => {
  it('creates and retrieves a comment', async () => {
    const created = await commentService.create({ name: 'sample-comment', status: 'comment_active' });
    const fetched = await commentService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
