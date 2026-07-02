import { PageRepository } from '../repositories/page.repository';
import { Page } from '../entities/page';

export class EventsController {
  constructor(private repo: PageRepository) {}

  showEventsPage(): Page | undefined {
    return this.repo.findBySlug('events');
  }
}
