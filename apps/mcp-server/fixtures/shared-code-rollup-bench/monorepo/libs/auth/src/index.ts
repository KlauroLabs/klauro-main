export class AuthGuard {
  canActivate(): boolean {
    return true;
  }
}

export class TokenService {
  verify(token: string): boolean {
    return token.length > 0;
  }
}

export function resolveUserRole(token: string): string {
  return token ? 'user' : 'anonymous';
}
