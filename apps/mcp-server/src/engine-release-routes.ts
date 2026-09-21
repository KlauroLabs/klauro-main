import * as fs from 'fs-extra';
import * as path from 'path';

import {
  artifactFor,
  ENGINE_PLATFORMS,
  isEnginePlatform,
  latestFor,
  released,
  versionsOf,
  type EngineManifest,
} from './engine-release';

export function engineDownloadsRoot(): string {
  return process.env.KLAURO_DOWNLOADS_DIR || '/opt/klauro/downloads';
}

export async function publishedEngines(): Promise<EngineManifest> {
  try {
    const manifest = path.join(engineDownloadsRoot(), 'engine', 'manifest.json');
    return JSON.parse(await fs.readFile(manifest, 'utf8'));
  } catch {
    return { artifacts: [] };
  }
}

export async function engineReleaseAsked(
  route: string,
  query: URLSearchParams,
  baseUrl: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const manifest = await publishedEngines();
  const asked = route.slice('/api/engine/'.length);

  if (asked === 'versions') {
    return { status: 200, body: { name: 'klauro-engine', versions: versionsOf(manifest) } };
  }

  const platform = query.get('platform') || undefined;
  if (!isEnginePlatform(platform)) {
    return {
      status: 400,
      body: {
        error: 'unknown_platform',
        message: `platform must be one of ${ENGINE_PLATFORMS.join(', ')}`,
        platforms: ENGINE_PLATFORMS,
      },
    };
  }

  const artifact = asked === 'latest'
    ? latestFor(manifest, platform)
    : artifactFor(manifest, asked, platform);
  if (!artifact) {
    return {
      status: 404,
      body: {
        error: 'no_artifact',
        message: `no klauro-engine build is published for ${platform} at ${asked}`,
        versions: versionsOf(manifest),
      },
    };
  }
  return { status: 200, body: released(artifact, baseUrl) as unknown as Record<string, unknown> };
}
