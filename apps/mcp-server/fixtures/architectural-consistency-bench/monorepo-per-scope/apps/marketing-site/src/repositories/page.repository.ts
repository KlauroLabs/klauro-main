import { Page } from '../entities/page';

export class PageRepository {
  private pages: Page[] = [];

  findBySlug(slug: string): Page | undefined {
    return this.pages.find(p => p.slug === slug);
  }

  save(page: Page): Page {
    this.pages.push(page);
    return page;
  }
}
