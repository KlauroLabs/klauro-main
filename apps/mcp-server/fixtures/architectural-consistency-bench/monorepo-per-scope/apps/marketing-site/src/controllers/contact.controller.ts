import { PageRepository } from '../repositories/page.repository';
import { Page } from '../entities/page';

export class ContactController {
  constructor(private repo: PageRepository) {}

  showContactPage(): Page | undefined {
    return this.repo.findBySlug('contact');
  }
}
