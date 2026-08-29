import * as fs from 'fs';
import * as path from 'path';
import type { CASLibrary } from '../../types/cas.types';

export function detectLibrariesFromManifests(projectPath: string): CASLibrary[] {
  const libraries: CASLibrary[] = [];
  const seen = new Set<string>();

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
        if (!deps) return;
        for (const [name, version] of Object.entries(deps)) {
          const key = `${name}@${type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          libraries.push({
            id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
            name,
            version: version.replace(/^[\^~>=<]/, ''),
            type,
            package_manager: 'npm'
          });
        }
      };
      addDeps(pkg.dependencies, 'production');
      addDeps(pkg.devDependencies, 'development');
      addDeps(pkg.peerDependencies, 'peer');
      addDeps(pkg.optionalDependencies, 'optional');
    } catch { }
  }

  const requirementsFiles = ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt'];
  for (const reqFile of requirementsFiles) {
    const reqPath = path.join(projectPath, reqFile);
    if (fs.existsSync(reqPath)) {
      try {
        const rawContent = fs.readFileSync(reqPath);
        const content = rawContent.toString('utf8').replace(/\0/g, '').replace(/\uFEFF/g, '');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
          const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
          if (match) {
            const name = match[1];
            const version = match[2]?.split(',')[0]?.trim();
            const key = `py_${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              version,
              type: 'production',
              package_manager: 'pip'
            });
          }
        }
      } catch { }
    }
  }

  const pipfilePath = path.join(projectPath, 'Pipfile');
  if (fs.existsSync(pipfilePath) && libraries.filter(l => l.package_manager === 'pip').length === 0) {
    try {
      const content = fs.readFileSync(pipfilePath, 'utf8');
      let section = '';
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
          continue;
        }
        if (section === 'packages' || section === 'dev-packages') {
          const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=/);
          if (match) {
            const name = match[1];
            const key = `py_${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              type: section === 'dev-packages' ? 'development' : 'production',
              package_manager: 'pipenv'
            });
          }
        }
      }
    } catch { }
  }

  const cargoPath = path.join(projectPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf8');
      let section = '';
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
          continue;
        }
        if (section === 'dependencies' || section === 'dev-dependencies') {
          const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
          if (match) {
            const name = match[1];
            const key = `cargo_${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const versionMatch = trimmed.match(/"([^"]+)"/);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              version: versionMatch?.[1],
              type: section === 'dev-dependencies' ? 'development' : 'production',
              package_manager: 'cargo'
            });
          }
        }
      }
    } catch { }
  }

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath) && libraries.filter(l => l.package_manager === 'pip' || l.package_manager === 'pipenv').length === 0) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      let inDeps = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.match(/^\[.*dependencies.*\]/i)) {
          inDeps = true;
          continue;
        }
        if (trimmed.startsWith('[') && inDeps) {
          inDeps = false;
          continue;
        }
        if (inDeps) {
          if (/^"?[a-zA-Z0-9_.-]+"?\s*=\s*\[/.test(trimmed)) {
            continue;
          }
          const match = trimmed.match(/^"?([a-zA-Z0-9_.-]+)"?\s*(?:[><=!~]+\s*"?([^",\]]+))?/);
          if (match && !match[1].startsWith('#')) {
            const name = match[1];
            const key = `py_${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              version: match[2]?.replace(/"/g, ''),
              type: 'production',
              package_manager: 'pip'
            });
          }
        }
      }
    } catch { }
  }

  if (libraries.length === 0) {
    const manifestNames = ['package.json', 'requirements.txt', 'Cargo.toml', 'Pipfile', 'pyproject.toml', 'go.mod', 'Gemfile'];
    try {
      const entries = fs.readdirSync(projectPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === '__pycache__') continue;
        const subPath = path.join(projectPath, entry.name);
        for (const manifest of manifestNames) {
          const manifestPath = path.join(subPath, manifest);
          if (!fs.existsSync(manifestPath)) continue;
          if (manifest === 'package.json') {
            try {
              const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
                if (!deps) return;
                for (const [name, version] of Object.entries(deps)) {
                  const key = `${name}@${type}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  libraries.push({
                    id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                    name,
                    version: version.replace(/^[\^~>=<]/, ''),
                    type,
                    package_manager: 'npm'
                  });
                }
              };
              addDeps(pkg.dependencies, 'production');
              addDeps(pkg.devDependencies, 'development');
            } catch { }
          } else if (manifest === 'requirements.txt') {
            try {
              const content = fs.readFileSync(manifestPath, 'utf8');
              for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
                const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
                if (match) {
                  const name = match[1];
                  const key = `py_${name}`;
                  if (seen.has(key)) continue;
                  seen.add(key);
                  libraries.push({
                    id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                    name,
                    version: match[2]?.split(',')[0]?.trim(),
                    type: 'production',
                    package_manager: 'pip'
                  });
                }
              }
            } catch { }
          } else if (manifest === 'Cargo.toml') {
            try {
              const content = fs.readFileSync(manifestPath, 'utf8');
              let section = '';
              for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('[')) {
                  section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
                  continue;
                }
                if (section === 'dependencies' || section === 'dev-dependencies') {
                  const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
                  if (match) {
                    const name = match[1];
                    const key = `cargo_${name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const versionMatch = trimmed.match(/"([^"]+)"/);
                    libraries.push({
                      id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                      name,
                      version: versionMatch?.[1],
                      type: section === 'dev-dependencies' ? 'development' : 'production',
                      package_manager: 'cargo'
                    });
                  }
                }
              }
            } catch { }
          }
          if (libraries.length > 0) break;
        }
        if (libraries.length > 0) break;
      }
    } catch { }
  }

  return libraries;
}
