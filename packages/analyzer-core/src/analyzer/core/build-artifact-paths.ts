const BUILD_ARTIFACT_DIRECTORY_PATTERN = /^dist(?:[-_.][^/]+)?$/i;

export const BUILD_ARTIFACT_GLOBS = [
  'dist/**',
  '**/dist/**',
  'dist-*/**',
  '**/dist-*/**',
  'dist_*/**',
  '**/dist_*/**',
  'dist.*/**',
  '**/dist.*/**'
] as const;

export const THIRD_PARTY_SOURCE_GLOBS = [
  'vendor/**',
  '**/vendor/**',
  'vendors/**',
  '**/vendors/**',
  'vendored/**',
  '**/vendored/**',
  'third_party/**',
  '**/third_party/**',
  'third-party/**',
  '**/third-party/**',
] as const;

export function isBuildArtifactDirectoryName(name: string): boolean {
  return BUILD_ARTIFACT_DIRECTORY_PATTERN.test(name);
}
