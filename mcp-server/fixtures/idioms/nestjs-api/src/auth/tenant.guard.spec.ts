import { TenantGuard } from './tenant.guard';

describe('TenantGuard', () => {
  it('rejects requests without tenant scope', () => {
    const guard = new TenantGuard();
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ user: {} }),
      }),
    };

    expect(() => guard.canActivate(context as any)).toThrow('Tenant scope is required');
  });
});
