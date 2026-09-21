export const ENGINE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'] as const;

export type EnginePlatform = (typeof ENGINE_PLATFORMS)[number];

export interface EngineArtifact {
  version: string;
  platform: EnginePlatform;
  path: string;
  encoding: 'zstd';
  size: number;
  sha256: string;
  decompressedSize: number;
  decompressedSha256: string;
  publishedAt: string;
  minClient?: string;
  signature?: string;
}

export interface EngineManifest {
  artifacts: EngineArtifact[];
}

export interface EngineRelease {
  name: 'klauro-engine';
  version: string;
  platform: EnginePlatform;
  url: string;
  encoding: 'zstd';
  size: number;
  sha256: string;
  decompressedSize: number;
  decompressedSha256: string;
  publishedAt: string;
  minClient?: string;
  signature?: string;
}

export function isEnginePlatform(candidate: string | undefined): candidate is EnginePlatform {
  return ENGINE_PLATFORMS.includes(candidate as EnginePlatform);
}

function ordered(version: string): number[] {
  return version.split('.').map(part => Number.parseInt(part, 10) || 0);
}

export function laterVersion(left: string, right: string): number {
  const one = ordered(left);
  const other = ordered(right);
  for (let at = 0; at < Math.max(one.length, other.length); at += 1) {
    const difference = (one[at] ?? 0) - (other[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function builtFor(manifest: EngineManifest, platform: EnginePlatform): EngineArtifact[] {
  return manifest.artifacts
    .filter(artifact => artifact.platform === platform)
    .sort((left, right) => laterVersion(right.version, left.version));
}

export function latestFor(manifest: EngineManifest, platform: EnginePlatform): EngineArtifact | null {
  return builtFor(manifest, platform)[0] ?? null;
}

export function artifactFor(
  manifest: EngineManifest,
  version: string,
  platform: EnginePlatform
): EngineArtifact | null {
  return manifest.artifacts.find(
    artifact => artifact.version === version && artifact.platform === platform
  ) ?? null;
}

export function versionsOf(manifest: EngineManifest): Array<{
  version: string;
  platforms: EnginePlatform[];
  publishedAt: string;
}> {
  const held = new Map<string, { platforms: Set<EnginePlatform>; publishedAt: string }>();
  for (const artifact of manifest.artifacts) {
    const known = held.get(artifact.version) ?? { platforms: new Set(), publishedAt: artifact.publishedAt };
    known.platforms.add(artifact.platform);
    if (artifact.publishedAt < known.publishedAt) known.publishedAt = artifact.publishedAt;
    held.set(artifact.version, known);
  }
  return [...held]
    .sort(([left], [right]) => laterVersion(right, left))
    .map(([version, known]) => ({
      version,
      platforms: [...known.platforms].sort(),
      publishedAt: known.publishedAt,
    }));
}

export function released(artifact: EngineArtifact, baseUrl: string): EngineRelease {
  return {
    name: 'klauro-engine',
    version: artifact.version,
    platform: artifact.platform,
    url: `${baseUrl.replace(/\/+$/, '')}/${artifact.path.replace(/^\/+/, '')}`,
    encoding: artifact.encoding,
    size: artifact.size,
    sha256: artifact.sha256,
    decompressedSize: artifact.decompressedSize,
    decompressedSha256: artifact.decompressedSha256,
    publishedAt: artifact.publishedAt,
    ...(artifact.minClient ? { minClient: artifact.minClient } : {}),
    ...(artifact.signature ? { signature: artifact.signature } : {}),
  };
}
