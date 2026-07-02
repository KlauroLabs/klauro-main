import type { EvidenceProvider } from './types';
import { binTargetsProvider } from './providers/bin-targets';
import { ciDeployProvider } from './providers/ci-deploy';
import { containerProvider } from './providers/container';
import { deployManifestsProvider } from './providers/deploy-manifests';
import { dotnetProvider } from './providers/dotnet';
import { installerProvider } from './providers/installer';
import { jvmProvider } from './providers/jvm';
import { mobileProvider } from './providers/mobile';
import { nativeProvider } from './providers/native';
import { packageManifestProvider } from './providers/package-manifest';
import { phpProvider } from './providers/php';
import { pythonProvider } from './providers/python';
import { rubyProvider } from './providers/ruby';

/**
 * Built-in evidence providers, in collection order. Order matters only for
 * DeployableEvidence[] ordering prior to dedupe (dedupe is order-preserving:
 * first occurrence per `${tier}::${kind}::${root_path}::${name}` wins), so
 * this list is kept in the same order the original monolithic collector ran
 * its helpers in.
 */
export const BUILTIN_PROVIDERS: EvidenceProvider[] = [
  containerProvider,
  installerProvider,
  ciDeployProvider,
  binTargetsProvider,
  packageManifestProvider,
  phpProvider,
  pythonProvider,
  rubyProvider,
  jvmProvider,
  dotnetProvider,
  deployManifestsProvider,
  nativeProvider,
  mobileProvider,
];

const registeredProviders: EvidenceProvider[] = [...BUILTIN_PROVIDERS];

/**
 * Register an additional EvidenceProvider (e.g. for a new ecosystem) beyond
 * the built-ins. Intended for the per-ecosystem breadth fan-out: each new
 * ecosystem provider file calls this once at module load, or a caller wires
 * it explicitly before invoking collectDeployableEvidence.
 */
export function registerProvider(provider: EvidenceProvider): void {
  registeredProviders.push(provider);
}

/** Returns all currently registered providers (built-ins plus any registered via registerProvider). */
export function getProviders(): EvidenceProvider[] {
  return [...registeredProviders];
}
