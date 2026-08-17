import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import { fileNodeIdFromExistingAnalysis } from '../../core/file-node-resolution';

const ZUSTAND_IMPORT = /import\s+.*\bfrom\s+['"]zustand['"]/;
const ZUSTAND_CREATE = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*create\s*[<(]/g;
const PERSIST_MIDDLEWARE = /persist\s*\(/;
const DEVTOOLS_MIDDLEWARE = /devtools\s*\(/;
const IMMER_MIDDLEWARE = /immer\s*\(/;
const PERSIST_CONFIG = /name\s*:\s*['"]([^'"]+)['"]/;
const PERSIST_STORAGE = /(?:getStorage|storage)\s*:\s*\(\)\s*=>\s*(\w+)/;

export class ZustandAnalyzer extends BaseAnalyzer {
  constructor() {
    super('zustand', 'Zustand Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return 'zustand' in deps;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);

    const sourceFiles = this.capAndPrioritizeSourceFiles(await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
      absolute: false,
      nodir: true
    }), 'Zustand candidate files');

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenNodeIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      if (!this.hasZustandUsage(content)) continue;

      const fileNodeId = fileNodeIdFromExistingAnalysis(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      this.extractStores(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
    }

    return this.createContribution(nodes, edges, [], exitPoints, {
      library: 'zustand',
      storesFound: nodes.filter(n => n.type === 'zustand_store').length
    });
  }

  private hasZustandUsage(content: string): boolean {
    return ZUSTAND_IMPORT.test(content) ||
           (content.includes('create(') && /create\s*[<(]\s*\(\s*(?:set|get)/g.test(content));
  }

  private extractStores(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined,
    nodes: CASNode[], edges: CASEdge[], exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    ZUSTAND_CREATE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ZUSTAND_CREATE.exec(content)) !== null) {
      const storeName = match[1];
      const nodeId = `store_zustand_${sanitizedPath}_${storeName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const storeBody = content.substring(match.index, Math.min(content.length, match.index + 3000));

      const stateShape = this.extractStateShape(storeBody);
      const actions = this.extractActions(storeBody);
      const middleware = this.extractMiddleware(storeBody);
      const persistence = this.extractPersistence(storeBody);

      nodes.push(this.createNode(
        nodeId, storeName, 'zustand_store', 3, relativePath, undefined, undefined,
        {
          library: 'zustand',
          state_shape: stateShape,
          actions: actions.map(a => a.name),
          middleware,
          persistence
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'
        ));
      }

      for (const action of actions) {
        if (action.hasApiCall) {
          exitPoints.push(this.createExitPoint(
            `exit_zustand_${sanitizedPath}_${storeName}_${action.name}`,
            fileNodeId || nodeId, 'api', `API call from ${storeName}.${action.name}`,
            undefined, { endpoint: action.apiEndpoint || 'unknown' },
            { action: 'read-write', async: true },
            { framework: 'zustand', store: storeName, sourceFile: relativePath }
          ));
        }
      }
    }
  }

  private extractStateShape(storeBody: string): Array<{ key: string; type: string; initial_value?: string }> {
    const shape: Array<{ key: string; type: string; initial_value?: string }> = [];
    const seen = new Set<string>();

    const returnPattern = /\(\s*(?:set|get)\s*(?:,\s*(?:set|get))?\s*\)\s*=>\s*\(?\s*\{([\s\S]*?)\}\s*\)?/;
    const returnMatch = returnPattern.exec(storeBody);
    if (!returnMatch) return shape;

    const body = returnMatch[1];
    const propPattern = /(\w+)\s*:\s*([^,\n}]+)/g;
    let propMatch;
    while ((propMatch = propPattern.exec(body)) !== null) {
      const key = propMatch[1];
      const value = propMatch[2].trim();

      if (seen.has(key)) continue;
      seen.add(key);

      if (value.includes('=>') || value.includes('function') || value.startsWith('(') ||
          value.startsWith('async')) {
        continue;
      }

      let type = 'unknown';
      if (value === 'null') type = 'null';
      else if (value === 'true' || value === 'false') type = 'boolean';
      else if (value === '[]') type = 'array';
      else if (value === '{}') type = 'object';
      else if (/^['"]/.test(value)) type = 'string';
      else if (/^\d/.test(value)) type = 'number';

      shape.push({ key, type, initial_value: value.substring(0, 50) });
    }

    return shape;
  }

  private extractActions(storeBody: string): Array<{ name: string; hasApiCall: boolean; apiEndpoint?: string }> {
    const actions: Array<{ name: string; hasApiCall: boolean; apiEndpoint?: string }> = [];
    const seen = new Set<string>();

    const actionPattern = /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g;
    let match;
    while ((match = actionPattern.exec(storeBody)) !== null) {
      const name = match[1];
      if (seen.has(name)) continue;
      seen.add(name);

      const actionBody = storeBody.substring(match.index, Math.min(storeBody.length, match.index + 500));
      const hasApiCall = actionBody.includes('fetch(') || actionBody.includes('axios') ||
                         actionBody.includes('.get(') || actionBody.includes('.post(');
      let apiEndpoint: string | undefined;
      if (hasApiCall) {
        const urlMatch = actionBody.match(/(?:fetch|get|post|put|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/);
        apiEndpoint = urlMatch?.[1];
      }

      actions.push({ name, hasApiCall, apiEndpoint });
    }

    return actions;
  }

  private extractMiddleware(storeBody: string): Array<{ name: string; type: string }> {
    const middleware: Array<{ name: string; type: string }> = [];

    if (PERSIST_MIDDLEWARE.test(storeBody)) {
      middleware.push({ name: 'persist', type: 'persistence' });
    }
    if (DEVTOOLS_MIDDLEWARE.test(storeBody)) {
      middleware.push({ name: 'devtools', type: 'devtools' });
    }
    if (IMMER_MIDDLEWARE.test(storeBody)) {
      middleware.push({ name: 'immer', type: 'immer' });
    }

    return middleware;
  }

  private extractPersistence(storeBody: string): { storage_type: string; name?: string } | undefined {
    if (!PERSIST_MIDDLEWARE.test(storeBody)) return undefined;

    const nameMatch = PERSIST_CONFIG.exec(storeBody);
    const storageMatch = PERSIST_STORAGE.exec(storeBody);

    let storageType = 'local_storage';
    if (storageMatch) {
      const storage = storageMatch[1].toLowerCase();
      if (storage.includes('session')) storageType = 'session_storage';
      else if (storage.includes('indexed') || storage.includes('idb')) storageType = 'indexed_db';
    }

    return {
      storage_type: storageType,
      name: nameMatch?.[1]
    };
  }

  protected getCapabilities(): string[] {
    return ['store-detection', 'state-shape-extraction', 'action-detection', 'middleware-detection', 'persistence-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
