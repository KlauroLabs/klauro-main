import { PageRepository } from '../repositories/page.repository';
import { Page } from '../entities/page';

export class LandingController {
  constructor(private repo: PageRepository) {}

  showLanding(): Page | undefined {
    return this.repo.findBySlug('home');
  }
}
