import { AuthGuard, TokenService } from '@fixture/auth';

export class ServiceAController {
  private guard = new AuthGuard();
  private tokens = new TokenService();

  handleRequest(token: string): boolean {
    return this.guard.canActivate() && this.tokens.verify(token);
  }
}
