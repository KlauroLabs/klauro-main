import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const CONFIGURE_STORE = /configureStore\s*\(\s*\{/g;
const CREATE_SLICE = /createSlice\s*\(\s*\{[\s\S]*?name:\s*['"](\w+)['"]/g;
const CREATE_ASYNC_THUNK = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createAsyncThunk\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g;
const CREATE_SELECTOR = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createSelector\s*\(/g;
const CREATE_API = /createApi\s*\(\s*\{/g;
const RTK_ENDPOINT = /(\w+)\s*:\s*builder\.(query|mutation)\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const DISPATCH_CALL = /dispatch\s*\(\s*(\w+)\s*\(/g;

export class ReduxAnalyzer extends BaseAnalyzer {
  constructor() {
    super('redux', 'Redux/RTK Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return '@reduxjs/toolkit' in deps || 'redux' in deps;
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
    }), 'Redux candidate files');

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
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

      if (!this.hasReduxUsage(content)) continue;

      const fileNodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      this.extractStoreConfiguration(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, seenNodeIds);
      this.extractSlices(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, seenNodeIds);
      this.extractAsyncThunks(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      this.extractSelectors(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, seenNodeIds);
      this.extractRTKQueryEndpoints(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, entryPoints, exitPoints, seenNodeIds);
      this.extractDispatchUsages(content, relativePath, sanitizedPath, fileNodeId, edges);
    }

    return this.createContribution(nodes, edges, entryPoints, exitPoints, {
      library: 'redux',
      slicesFound: nodes.filter(n => n.type === 'redux_slice').length,
      thunksFound: nodes.filter(n => n.type === 'async_thunk').length,
      selectorsFound: nodes.filter(n => n.type === 'redux_selector').length,
      rtkQueryEndpoints: nodes.filter(n => n.type === 'rtk_query_endpoint').length
    });
  }

  private hasReduxUsage(content: string): boolean {
    return content.includes('configureStore') || content.includes('createSlice') ||
           content.includes('createAsyncThunk') || content.includes('createSelector') ||
           content.includes('createApi') || content.includes('useSelector') ||
           content.includes('useDispatch') || content.includes('createStore');
  }

  private extractStoreConfiguration(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>
  ): void {
    CONFIGURE_STORE.lastIndex = 0;
    if (!CONFIGURE_STORE.test(content)) return;

    const nodeId = `store_redux_${sanitizedPath}`;
    if (seenNodeIds.has(nodeId)) return;
    seenNodeIds.add(nodeId);

    const reducerNames: string[] = [];
    const reducerPattern = /reducer\s*:\s*\{([^}]+)\}/;
    const reducerMatch = reducerPattern.exec(content);
    if (reducerMatch) {
      const fieldPattern = /(\w+)\s*(?::|,)/g;
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(reducerMatch[1])) !== null) {
        reducerNames.push(fieldMatch[1]);
      }
    }

    const middlewareNames: string[] = [];
    if (content.includes('middleware')) {
      const mwPattern = /(\w+)\.middleware/g;
      let mwMatch;
      while ((mwMatch = mwPattern.exec(content)) !== null) {
        middlewareNames.push(mwMatch[1]);
      }
    }

    nodes.push(this.createNode(
      nodeId, 'ReduxStore', 'redux_store', 2, relativePath, undefined, undefined,
      { library: 'redux', reducers: reducerNames, middleware: middlewareNames }
    ));
  }

  private extractSlices(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>
  ): void {
    CREATE_SLICE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_SLICE.exec(content)) !== null) {
      const sliceName = match[1];
      const nodeId = `slice_redux_${sliceName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const reducerActions: string[] = [];
      const sliceContent = content.substring(match.index, match.index + 2000);
      const reducersMatch = sliceContent.match(/reducers\s*:\s*\{([\s\S]*?)\}\s*[,}]/);
      if (reducersMatch) {
        const actionPattern = /(\w+)\s*(?::\s*\(|:\s*\{)/g;
        let actionMatch;
        while ((actionMatch = actionPattern.exec(reducersMatch[1])) !== null) {
          reducerActions.push(actionMatch[1]);
        }
      }

      const stateShape: Array<{ key: string; type: string }> = [];
      const initialStateMatch = sliceContent.match(/initialState\s*:\s*\{([\s\S]*?)\}\s*[,}]/);
      if (initialStateMatch) {
        const fieldPattern = /(\w+)\s*:/g;
        let fieldMatch;
        while ((fieldMatch = fieldPattern.exec(initialStateMatch[1])) !== null) {
          stateShape.push({ key: fieldMatch[1], type: 'unknown' });
        }
      }

      nodes.push(this.createNode(
        nodeId, sliceName, 'redux_slice', 3, relativePath, undefined, undefined,
        { library: 'redux', actions: reducerActions, state_shape: stateShape }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
      }
    }
  }

  private extractAsyncThunks(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    CREATE_ASYNC_THUNK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_ASYNC_THUNK.exec(content)) !== null) {
      const thunkName = match[1];
      const actionType = match[2];
      const nodeId = `thunk_redux_${sanitizedPath}_${thunkName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      nodes.push(this.createNode(
        nodeId, thunkName, 'async_thunk', 4, relativePath, undefined, undefined,
        { library: 'redux', action_type: actionType, async: true }
      ));

      const thunkBody = content.substring(match.index, match.index + 1000);
      const hasFetch = thunkBody.includes('fetch(') || thunkBody.includes('axios') ||
                       thunkBody.includes('.get(') || thunkBody.includes('.post(');
      if (hasFetch) {
        const urlMatch = thunkBody.match(/(?:fetch|get|post|put|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/);
        exitPoints.push(this.createExitPoint(
          `exit_thunk_${sanitizedPath}_${thunkName}`,
          fileNodeId || nodeId, 'api', `API call from ${thunkName}`,
          undefined, { endpoint: urlMatch?.[1] || 'unknown' },
          { action: 'read-write', async: true },
          { framework: 'redux', thunk: thunkName, sourceFile: relativePath }
        ));
      }
    }
  }

  private extractSelectors(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>
  ): void {
    CREATE_SELECTOR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_SELECTOR.exec(content)) !== null) {
      const selectorName = match[1];
      const nodeId = `selector_redux_${sanitizedPath}_${selectorName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const inputSelectors: string[] = [];
      const selectorBody = content.substring(match.index, match.index + 500);
      const inputPattern = /state\s*(?:=>|\.)\s*(?:state\.)?(\w+)/g;
      let inputMatch;
      while ((inputMatch = inputPattern.exec(selectorBody)) !== null) {
        inputSelectors.push(inputMatch[1]);
      }

      nodes.push(this.createNode(
        nodeId, selectorName, 'redux_selector', 4, relativePath, undefined, undefined,
        { library: 'redux', input_selectors: inputSelectors, memoized: true }
      ));
    }
  }

  private extractRTKQueryEndpoints(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    entryPoints: CASEntryPoint[], exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    CREATE_API.lastIndex = 0;
    if (!CREATE_API.test(content)) return;

    RTK_ENDPOINT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RTK_ENDPOINT.exec(content)) !== null) {
      const endpointName = match[1];
      const endpointType = match[2];
      const nodeId = `rtk_endpoint_${sanitizedPath}_${endpointName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const endpointBody = content.substring(match.index, match.index + 500);
      const urlMatch = endpointBody.match(/(?:url|query)\s*:\s*[`'"]([^`'"]+)[`'"]/);
      const methodMatch = endpointBody.match(/method\s*:\s*['"](\w+)['"]/);

      const metadata: Record<string, any> = {
        library: 'redux',
        endpoint_type: endpointType,
        url: urlMatch?.[1],
        method: methodMatch?.[1] || (endpointType === 'query' ? 'GET' : 'POST')
      };

      if (endpointType === 'mutation') {
        const invalidatesMatch = endpointBody.match(/invalidatesTags\s*:\s*\[([^\]]+)\]/);
        if (invalidatesMatch) {
          metadata.invalidates_tags = invalidatesMatch[1].match(/['"](\w+)['"]/g)?.map(t => t.replace(/['"]/g, '')) || [];
        }
      }

      nodes.push(this.createNode(
        nodeId, endpointName, 'rtk_query_endpoint', 4, relativePath, undefined, undefined, metadata
      ));

      exitPoints.push(this.createExitPoint(
        `exit_rtk_${sanitizedPath}_${endpointName}`,
        fileNodeId || nodeId, 'api', `RTK Query ${endpointType}: ${endpointName}`,
        undefined, { endpoint: urlMatch?.[1] || endpointName, service_id: 'rtk-query' },
        { method: methodMatch?.[1] || (endpointType === 'query' ? 'GET' : 'POST'), async: true },
        { framework: 'redux', endpoint_type: endpointType, sourceFile: relativePath }
      ));
    }
  }

  private extractDispatchUsages(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, edges: CASEdge[]
  ): void {
    DISPATCH_CALL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DISPATCH_CALL.exec(content)) !== null) {
      const actionName = match[1];
      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_dispatch_${sanitizedPath}_${actionName}`,
          fileNodeId, `action_${actionName}`, 'dispatches', 'behavioral',
          { action: actionName }
        ));
      }
    }
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
    }
    return undefined;
  }

  protected getCapabilities(): string[] {
    return ['slice-detection', 'thunk-detection', 'selector-detection', 'rtk-query-detection', 'dispatch-tracking', 'state-shape-extraction'];
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
