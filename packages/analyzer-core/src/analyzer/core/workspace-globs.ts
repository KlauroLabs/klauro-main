import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';


























const MAX_GLOB_MEMBERS = 500;


function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch) {
        const value = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (value) patterns.push(value);
        continue;
      }

      if (line.trim() !== '') inPackages = false;
    }
  }
  return patterns;
}

function readJsonSafe(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}







export function collectWorkspaceGlobPatterns(projectPath: string): string[] {
  const patterns: string[] = [];


  const pnpmWorkspacePath = path.join(projectPath, 'pnpm-workspace.yaml');
  try {
    if (fs.existsSync(pnpmWorkspacePath)) {
      const content = fs.readFileSync(pnpmWorkspacePath, 'utf8');
      patterns.push(...parsePnpmWorkspaceYaml(content));
    }
  } catch {

  }


  const rootPackageJson = readJsonSafe(path.join(projectPath, 'package.json'));
  if (rootPackageJson && rootPackageJson.workspaces) {
    const ws = rootPackageJson.workspaces;
    if (Array.isArray(ws)) {
      patterns.push(...ws.filter((p: unknown) => typeof p === 'string'));
    } else if (ws && Array.isArray(ws.packages)) {
      patterns.push(...ws.packages.filter((p: unknown) => typeof p === 'string'));
    }
  }




  const nxConfig = readJsonSafe(path.join(projectPath, 'nx.json'));
  if (nxConfig && nxConfig.workspaceLayout) {
    const { appsDir, libsDir } = nxConfig.workspaceLayout as { appsDir?: string; libsDir?: string };
    if (typeof appsDir === 'string' && appsDir) patterns.push(`${appsDir}/*`);
    if (typeof libsDir === 'string' && libsDir) patterns.push(`${libsDir}/*`);
  }

  return Array.from(new Set(patterns.map((p) => p.trim()).filter(Boolean)))
    .filter((p) => !p.startsWith('!'));
}






export function resolveWorkspaceGlobMembers(projectPath: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const members = new Set<string>();

  for (const pattern of patterns) {
    try {
      const matches = globSync(pattern, {
        cwd: projectPath,
        ignore: ['**/node_modules/**'],
        nodir: false,
      });
      for (const match of matches) {
        const absolute = path.join(projectPath, match);
        let isDir = false;
        try {
          isDir = fs.statSync(absolute).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        members.add(absolute);
        if (members.size >= MAX_GLOB_MEMBERS) return Array.from(members);
      }
    } catch {

    }
  }

  return Array.from(members);
}









export function discoverWorkspaceGlobRootsWithoutManifest(
  projectPath: string,
  hasOwnPackageBoundaryManifest: (absoluteDir: string) => boolean,
): string[] {
  const patterns = collectWorkspaceGlobPatterns(projectPath);
  if (patterns.length === 0) return [];
  const members = resolveWorkspaceGlobMembers(projectPath, patterns);
  return members.filter((dir) => !hasOwnPackageBoundaryManifest(dir));
}
