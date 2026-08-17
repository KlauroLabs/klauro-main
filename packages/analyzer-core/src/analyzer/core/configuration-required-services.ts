import type { CASConfiguration, CASExitPoint, CASExternalService } from '../../types/cas.types';

type RequiredService = NonNullable<CASConfiguration['required_services']>[number];

function normalizedServiceKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function buildRequiredServices(
  exitPoints: CASExitPoint[],
  externalServices: CASExternalService[],
): RequiredService[] {
  const services = new Map<string, RequiredService>();
  const add = (service: string | undefined, optional: boolean): void => {
    const displayName = String(service || '').trim();
    const key = normalizedServiceKey(displayName);
    if (!key) return;
    const existing = services.get(key);
    if (existing) {
      existing.optional = existing.optional && optional;
      return;
    }
    services.set(key, { service: displayName, optional });
  };

  for (const service of externalServices) add(service.name, false);
  for (const exitPoint of exitPoints) {
    if (exitPoint.type === 'message') {
      add(exitPoint.target?.service_id || exitPoint.target?.sdk || 'message_queue', false);
    }
  }

  return [...services.values()];
}
