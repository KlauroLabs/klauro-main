import { PageRepository } from '../repositories/page.repository';
import { Page } from '../entities/page';

// apps/marketing-site's own local norm: this is a small static-content app
// with no service layer at all — controllers call the repository directly,
// consistently, everywhere in this scope. That is a DIFFERENT style than
// apps/api's handler->service->repo norm, but it is internally consistent
// within marketing-site, so it must NOT be flagged.
export class PageController {
  constructor(private repo: PageRepository) {}

  showPage(slug: string): Page | undefined {
    return this.repo.findBySlug(slug);
  }
}
