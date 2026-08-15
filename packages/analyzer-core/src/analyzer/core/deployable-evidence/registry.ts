import type { EvidenceProvider } from './types';
import { binTargetsProvider } from './providers/bin-targets';
import { ciDeployProvider } from './providers/ci-deploy';
import { containerProvider } from './providers/container';
import { deployManifestsProvider } from './providers/deploy-manifests';
import { desktopPackagingProvider } from './providers/desktop-packaging';
import { dotnetProvider } from './providers/dotnet';
import { installerProvider } from './providers/installer';
import { jvmProvider } from './providers/jvm';
import { mobileProvider } from './providers/mobile';
import { nativeProvider } from './providers/native';
import { packageManifestProvider } from './providers/package-manifest';
import { phpProvider } from './providers/php';
import { pythonProvider } from './providers/python';
import { rubyProvider } from './providers/ruby';








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
  desktopPackagingProvider,
];

const registeredProviders: EvidenceProvider[] = [...BUILTIN_PROVIDERS];







export function registerProvider(provider: EvidenceProvider): void {
  registeredProviders.push(provider);
}


export function getProviders(): EvidenceProvider[] {
  return [...registeredProviders];
}
