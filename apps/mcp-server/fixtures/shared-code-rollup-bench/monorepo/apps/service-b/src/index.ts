import { AuthGuard, resolveUserRole } from '@fixture/auth';

export class ServiceBController {
  private guard = new AuthGuard();

  handleRequest(token: string): string {
    if (!this.guard.canActivate()) return 'denied';
    return resolveUserRole(token);
  }
}
