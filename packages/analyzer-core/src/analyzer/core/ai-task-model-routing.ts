export interface AITaskModelRoute {
  model?: string;
  provider?: string;
}

export function toAIContextRoute(route: AITaskModelRoute): { model?: string; model_provider?: string } {
  return { model: route.model, model_provider: route.provider };
}

export function resolveCapabilityCatalogRoute(
  env: NodeJS.ProcessEnv,
  narrativeModel?: string,
): AITaskModelRoute {
  return {
    model: env.KLAURO_CAPABILITY_CATALOG_MODEL ||
      env.DEEPINFRA_STRUCTURED_MODEL ||
      env.OPENAI_STRUCTURED_MODEL ||
      narrativeModel,
    provider: env.KLAURO_CAPABILITY_CATALOG_PROVIDER ||
      (env.DEEPINFRA_STRUCTURED_MODEL ? 'deepinfra' : undefined),
  };
}

export function resolveCapabilityDescriptionRoute(
  env: NodeJS.ProcessEnv,
  narrativeModel?: string,
): AITaskModelRoute {
  return {
    model: env.KLAURO_CAPABILITY_DESCRIPTION_MODEL || narrativeModel,
    provider: env.KLAURO_CAPABILITY_DESCRIPTION_PROVIDER ||
      (env.DEEPINFRA_NARRATIVE_MODEL ? 'deepinfra' : undefined),
  };
}

export function shouldReauthorCatalogDescriptions(
  env: NodeJS.ProcessEnv,
  catalog: AITaskModelRoute,
  description: AITaskModelRoute,
): boolean {
  const override = env.KLAURO_REAUTHOR_CATALOG_DESCRIPTIONS;
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  const catalogModel = catalog.model?.trim().toLowerCase();
  const descriptionModel = description.model?.trim().toLowerCase();
  return Boolean(catalogModel && descriptionModel && catalogModel !== descriptionModel);
}

export function shouldReauthorCapabilityDescriptions(env: NodeJS.ProcessEnv, narrativeModel?: string): boolean {
  return shouldReauthorCatalogDescriptions(
    env,
    resolveCapabilityCatalogRoute(env, narrativeModel),
    resolveCapabilityDescriptionRoute(env, narrativeModel),
  );
}

export function capabilityDescriptionBatchSize(
  targetCount: number,
  concurrency: number,
  configuredBatchSize?: number,
): number {
  if (configuredBatchSize !== undefined && Number.isFinite(configuredBatchSize) && configuredBatchSize > 0) {
    return Math.max(1, Math.min(12, Math.floor(configuredBatchSize)));
  }
  return Math.max(1, Math.min(12, Math.ceil(targetCount / Math.max(1, concurrency))));
}
