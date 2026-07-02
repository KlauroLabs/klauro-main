import { PageRepository } from '../repositories/page.repository';
import { Page } from '../entities/page';
import { generateId, sanitizeId } from '../../../../packages/shared/src/id-utils';

export class BlogController {
  constructor(private repo: PageRepository) {}

  showPost(slug: string): Page | undefined {
    return this.repo.findBySlug(sanitizeId(slug));
  }

  publishPost(page: Page): Page {
    return this.repo.save({ ...page, slug: page.slug || generateId('post') });
  }
}
