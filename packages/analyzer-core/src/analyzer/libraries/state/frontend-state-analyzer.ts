import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { glob } from 'glob';

/**
 * Frontend State Analyzer — MobX, Recoil, Jotai, Valtio, Pinia (Vue), and
 * NgRx (Angular). Complements ReduxAnalyzer / ZustandAnalyzer (already own
 * their own libraries) by covering the rest of the frontend-state field.
 *
 * Surfaces stores/atoms/proxies as state nodes and their action/reducer/effect
 * surface as edges, plus dispatch/select call sites as exit points, so agents
 * can answer "what mutates this state" (blast-radius for state mutation).
 *
 * Evidence-based: every extractor is gated on the file importing the relevant
 * package (mobx, recoil, jotai, valtio, pinia, @ngrx/*) — never on bare
 * keyword/vocab matching, since terms like `atom`, `store`, `select`, and
 * `action` collide across these libraries and with unrelated code.
 */

const MOBX_IMPORT = /from\s+['"]mobx(?:-react(?:-lite)?)?['"]/;
const MOBX_OBSERVABLE_CLASS_DECORATOR = /@observable\s+(\w+)/g;
const MOBX_MAKE_OBSERVABLE = /makeObservable\s*\(\s*this\s*,\s*\{([\s\S]*?)\}\s*\)/g;
const MOBX_MAKE_AUTO_OBSERVABLE = /makeAutoObservable\s*\(\s*this\s*\)/;
const MOBX_ACTION = /@action(?:\.bound)?\s+(\w+)|(\w+)\s*=\s*action\s*\(/g;
const MOBX_COMPUTED = /@computed\s+get\s+(\w+)|(?:get\s+(\w+)\s*\(\)\s*\{[^}]*\}\s*)/g;
const MOBX_STORE_CLASS = /class\s+(\w+Store)\b/g;

const RECOIL_IMPORT = /from\s+['"]recoil['"]/;
const RECOIL_ATOM = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*atom\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const RECOIL_SELECTOR = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*selector\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const RECOIL_USE_SET_STATE = /useSetRecoilState\s*\(\s*(\w+)\s*\)/g;
const RECOIL_USE_RECOIL_STATE = /useRecoilState\s*\(\s*(\w+)\s*\)/g;

const JOTAI_IMPORT = /from\s+['"]jotai['"]/;
const JOTAI_ATOM = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*atom\s*(?:<[^>]*>)?\s*\(/g;
const JOTAI_USE_ATOM = /useAtom\s*\(\s*(\w+)\s*\)/g;
const JOTAI_USE_SET_ATOM = /useSetAtom\s*\(\s*(\w+)\s*\)/g;

const VALTIO_IMPORT = /from\s+['"]valtio['"]/;
const VALTIO_PROXY = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*proxy\s*(?:<[^>]*>)?\s*\(/g;
const VALTIO_SNAPSHOT = /snapshot\s*\(\s*(\w+)\s*\)/g;
const VALTIO_SUBSCRIBE = /subscribe\s*\(\s*(\w+)\s*,/g;

const PINIA_IMPORT = /from\s+['"]pinia['"]/;
const PINIA_DEFINE_STORE = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*defineStore\s*\(\s*['"]([^'"]+)['"]/g;
// Matches only method-shorthand definitions (`name(args) {`), anchored so it
// cannot match nested call expressions like `this.items.push(item)` inside a
// method body — only a definition is followed by a `{` block, a call isn't.
const PINIA_METHOD_NAME = /(?:^\s*|[{,]\s*)(\w+)\s*\([^)]*\)\s*\{/g;

const NGRX_IMPORT = /from\s+['"]@ngrx\/(store|effects)['"]/;
const NGRX_CREATE_REDUCER = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createReducer\s*\(/g;
const NGRX_CREATE_ACTION = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createAction\s*\(\s*['"]([^'"]+)['"]/g;
const NGRX_CREATE_EFFECT = /(\w+)\s*=\s*createEffect\s*\(/g;
const NGRX_CREATE_SELECTOR = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createSelector\s*\(/g;
const NGRX_STORE_SELECT = /store\.select\s*\(\s*(\w+)\s*\)/g;
const NGRX_STORE_DISPATCH = /store\.dispatch\s*\(\s*(\w+)\s*\(/g;

const XSTATE_IMPORT = /from\s+['"]xstate['"]/;
const XSTATE_CREATE_MACHINE = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createMachine\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const XSTATE_STATE_KEY = /^\s*(\w+)\s*:\s*\{/gm;
const XSTATE_EVENT_KEY = /\bon\s*:\s*\{([^}]*)\}/g;
const XSTATE_EVENT_NAME = /(\w+)\s*:/g;
const XSTATE_USE_MACHINE = /(?:const\s*\[\s*\w+\s*,\s*(\w+)\s*\]|(\w+))\s*=\s*useMachine\s*(?:<[^>]*>)?\s*\(\s*(\w+)/g;
const XSTATE_SEND = /(\w+)\s*\.\s*send\s*\(|(?<![.\w])send\s*\(/g;
const XSTATE_SUBSCRIBE = /(\w+)\s*\.\s*subscribe\s*\(/g;

export class FrontendStateAnalyzer extends BaseAnalyzer {
  constructor() {
    super('frontend-state', 'Frontend State Management Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    return this.hasNpmDependency(projectPath, [
      'mobx', 'mobx-react', 'mobx-react-lite',
      'recoil',
      'jotai',
      'valtio',
      'pinia',
      '@ngrx/store', '@ngrx/effects',
      'xstate', '@xstate/react', '@xstate/fsm',
    ]);
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);

    const sourceFiles = this.capAndPrioritizeSourceFiles(await glob(
      '**/*.{ts,tsx,js,jsx,vue}',
      {
        cwd: projectPath,
        ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
        absolute: false,
        nodir: true,
      }
    ), 'frontend state candidate files');

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

      const fileNodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      if (MOBX_IMPORT.test(content)) {
        this.extractMobx(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, seenNodeIds);
      }
      if (RECOIL_IMPORT.test(content)) {
        this.extractRecoil(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if (JOTAI_IMPORT.test(content)) {
        this.extractJotai(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if (VALTIO_IMPORT.test(content)) {
        this.extractValtio(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if (PINIA_IMPORT.test(content)) {
        this.extractPinia(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, seenNodeIds);
      }
      if (NGRX_IMPORT.test(content)) {
        this.extractNgrx(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
      if (XSTATE_IMPORT.test(content)) {
        this.extractXState(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      }
    }

    return this.createContribution(nodes, edges, [], exitPoints, {
      library: 'frontend-state',
      storesFound: nodes.filter(n => n.type.endsWith('_store') || n.type.endsWith('_atom') || n.type.endsWith('_proxy')).length,
      mutationSurfaceFound: edges.filter(e => e.type === 'mutates').length,
    });
  }

  // ---- MobX ---------------------------------------------------------------

  private extractMobx(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>
  ): void {
    const storeNames: string[] = [];
    MOBX_STORE_CLASS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MOBX_STORE_CLASS.exec(content)) !== null) storeNames.push(match[1]);

    // Fallback: a class using makeObservable/makeAutoObservable without a *Store
    // naming convention still counts as a MobX store, so scan class bodies.
    if (storeNames.length === 0 && (MOBX_MAKE_AUTO_OBSERVABLE.test(content) || /makeObservable\s*\(/.test(content))) {
      const classMatch = /class\s+(\w+)\b/.exec(content);
      if (classMatch) storeNames.push(classMatch[1]);
    }

    if (storeNames.length === 0) return;

    const observableFields = new Set<string>();
    MOBX_OBSERVABLE_CLASS_DECORATOR.lastIndex = 0;
    while ((match = MOBX_OBSERVABLE_CLASS_DECORATOR.exec(content)) !== null) observableFields.add(match[1]);
    MOBX_MAKE_OBSERVABLE.lastIndex = 0;
    while ((match = MOBX_MAKE_OBSERVABLE.exec(content)) !== null) {
      const body = match[1];
      const fieldPattern = /(\w+)\s*:\s*observable/g;
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(body)) !== null) observableFields.add(fieldMatch[1]);
    }

    const actions = new Set<string>();
    MOBX_ACTION.lastIndex = 0;
    while ((match = MOBX_ACTION.exec(content)) !== null) {
      const name = match[1] || match[2];
      if (name) actions.add(name);
    }

    const computedProps = new Set<string>();
    MOBX_COMPUTED.lastIndex = 0;
    while ((match = MOBX_COMPUTED.exec(content)) !== null) {
      const name = match[1] || match[2];
      if (name) computedProps.add(name);
    }

    // makeAutoObservable(this) infers observables/actions/computed from the
    // class body itself (that's the point of "auto") rather than requiring
    // decorators or an explicit annotations map, so when it's present, walk
    // the class body directly: plain field initializers become observables,
    // non-getter methods become actions, and `get x()` becomes computed —
    // unless already found via an explicit decorator/annotation above.
    if (MOBX_MAKE_AUTO_OBSERVABLE.test(content)) {
      const classBody = this.extractBraceBlock(content, /class\s+\w+[^{]*\{/);
      if (classBody) {
        const fieldPattern = /^\s*(\w+)\s*(?::\s*[^=;\n]+)?\s*=\s*[^(][^;\n]*;/gm;
        let fieldMatch: RegExpExecArray | null;
        while ((fieldMatch = fieldPattern.exec(classBody)) !== null) {
          if (fieldMatch[1] === 'constructor') continue;
          observableFields.add(fieldMatch[1]);
        }

        const getterPattern = /get\s+(\w+)\s*\(\)\s*\{/g;
        let getterMatch: RegExpExecArray | null;
        while ((getterMatch = getterPattern.exec(classBody)) !== null) computedProps.add(getterMatch[1]);

        const methodPattern = /(?:^|\}\s*)(\w+)\s*\([^)]*\)\s*\{/gm;
        let methodMatch: RegExpExecArray | null;
        while ((methodMatch = methodPattern.exec(classBody)) !== null) {
          const name = methodMatch[1];
          if (name === 'constructor' || computedProps.has(name)) continue;
          actions.add(name);
        }
      }
    }

    for (const storeName of storeNames) {
      const nodeId = `mobx_store_${sanitizedPath}_${storeName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      nodes.push(this.createNode(
        nodeId, storeName, 'mobx_store', 3, relativePath, undefined, undefined,
        {
          library: 'mobx',
          observable_fields: Array.from(observableFields),
          actions: Array.from(actions),
          computed: Array.from(computedProps),
          subcategories: ['frontend-state-store', 'mobx'],
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
      }
      for (const action of actions) {
        edges.push(this.createEdge(
          `edge_mobx_mutates_${sanitizedPath}_${storeName}_${action}`,
          nodeId, nodeId, 'mutates', 'behavioral', { action }
        ));
      }
    }
  }

  // ---- Recoil ---------------------------------------------------------------

  private extractRecoil(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const atomNames = new Set<string>();
    RECOIL_ATOM.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RECOIL_ATOM.exec(content)) !== null) {
      const name = match[1];
      atomNames.add(name);
      this.addSimpleStateNode(nodes, edges, seenNodeIds, {
        nodeId: `recoil_atom_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId, nodeType: 'recoil_atom', library: 'recoil',
      });
    }

    RECOIL_SELECTOR.lastIndex = 0;
    while ((match = RECOIL_SELECTOR.exec(content)) !== null) {
      const name = match[1];
      this.addSimpleStateNode(nodes, edges, seenNodeIds, {
        nodeId: `recoil_selector_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId, nodeType: 'recoil_selector', library: 'recoil',
      });
    }

    this.addMutationSinks(content, RECOIL_USE_SET_STATE, atomNames, sanitizedPath, relativePath, fileNodeId, nodes, exitPoints, 'recoil', 'useSetRecoilState');
    this.addMutationSinks(content, RECOIL_USE_RECOIL_STATE, atomNames, sanitizedPath, relativePath, fileNodeId, nodes, exitPoints, 'recoil', 'useRecoilState');
  }

  // ---- Jotai ---------------------------------------------------------------

  private extractJotai(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const atomNames = new Set<string>();
    JOTAI_ATOM.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = JOTAI_ATOM.exec(content)) !== null) {
      const name = match[1];
      atomNames.add(name);
      this.addSimpleStateNode(nodes, edges, seenNodeIds, {
        nodeId: `jotai_atom_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId, nodeType: 'jotai_atom', library: 'jotai',
      });
    }

    this.addMutationSinks(content, JOTAI_USE_ATOM, atomNames, sanitizedPath, relativePath, fileNodeId, nodes, exitPoints, 'jotai', 'useAtom');
    this.addMutationSinks(content, JOTAI_USE_SET_ATOM, atomNames, sanitizedPath, relativePath, fileNodeId, nodes, exitPoints, 'jotai', 'useSetAtom');
  }

  // ---- Valtio ---------------------------------------------------------------

  private extractValtio(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const proxyNames = new Set<string>();
    VALTIO_PROXY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VALTIO_PROXY.exec(content)) !== null) {
      const name = match[1];
      proxyNames.add(name);
      this.addSimpleStateNode(nodes, edges, seenNodeIds, {
        nodeId: `valtio_proxy_${sanitizedPath}_${name}`,
        name, relativePath, fileNodeId, nodeType: 'valtio_proxy', library: 'valtio',
      });
    }

    this.addMutationSinks(content, VALTIO_SUBSCRIBE, proxyNames, sanitizedPath, relativePath, fileNodeId, nodes, exitPoints, 'valtio', 'subscribe');

    VALTIO_SNAPSHOT.lastIndex = 0;
    while ((match = VALTIO_SNAPSHOT.exec(content)) !== null) {
      const name = match[1];
      if (!proxyNames.has(name)) continue;
      // snapshot() is a read, not a mutation sink; recorded as a structural edge only.
      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_valtio_snapshot_${sanitizedPath}_${name}_${match.index}`,
          fileNodeId, `valtio_proxy_${sanitizedPath}_${name}`, 'reads', 'behavioral'
        ));
      }
    }
  }

  // ---- Pinia (Vue) -----------------------------------------------------------

  private extractPinia(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>
  ): void {
    PINIA_DEFINE_STORE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PINIA_DEFINE_STORE.exec(content)) !== null) {
      const [, varName, storeId] = match;
      const nodeId = `pinia_store_${sanitizedPath}_${storeId}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const storeBody = content.slice(match.index, Math.min(content.length, match.index + 4000));

      const actionsBlock = this.extractBraceBlock(storeBody, /actions\s*:\s*\{/);
      const gettersBlock = this.extractBraceBlock(storeBody, /getters\s*:\s*\{/);
      const stateBlock = this.extractBraceBlock(storeBody, /state\s*:\s*\(\)\s*=>\s*\(?\{/);
      const actions = actionsBlock ? this.extractPiniaMethodNames(actionsBlock) : [];
      const getters = gettersBlock ? this.extractPiniaMethodNames(gettersBlock) : [];
      const stateFields = stateBlock ? this.extractPiniaStateFields(stateBlock) : [];

      nodes.push(this.createNode(
        nodeId, storeId, 'pinia_store', 3, relativePath, undefined, undefined,
        {
          library: 'pinia',
          variable_name: varName,
          state_fields: stateFields,
          actions,
          getters,
          subcategories: ['frontend-state-store', 'pinia'],
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
      }
      for (const action of actions) {
        edges.push(this.createEdge(
          `edge_pinia_mutates_${sanitizedPath}_${storeId}_${action}`,
          nodeId, nodeId, 'mutates', 'behavioral', { action }
        ));
      }
    }
  }

  /**
   * Slices the `{ ... }` body immediately following an opening-brace pattern
   * (e.g. `actions: {`), tracking brace depth so a nested method body's own
   * closing brace doesn't truncate the block early — a plain non-greedy regex
   * (`\{([\s\S]*?)\}`) stops at the FIRST `}`, which for `actions: { foo() {
   * ... } }` is the inner method's closer, not the block's. Returns the
   * content between the outer braces, exclusive.
   */
  private extractBraceBlock(source: string, openPattern: RegExp): string | undefined {
    const openMatch = openPattern.exec(source);
    if (!openMatch) return undefined;
    const start = openMatch.index + openMatch[0].length;
    let depth = 1;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i);
      }
    }
    return source.slice(start);
  }

  private extractPiniaMethodNames(block: string): string[] {
    const methods = new Set<string>();
    PINIA_METHOD_NAME.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PINIA_METHOD_NAME.exec(block)) !== null) methods.add(match[1]);
    return Array.from(methods);
  }

  private extractPiniaStateFields(block: string): string[] {
    const fields = new Set<string>();
    const fieldPattern = /(\w+)\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = fieldPattern.exec(block)) !== null) fields.add(match[1]);
    return Array.from(fields);
  }

  // ---- NgRx (Angular) --------------------------------------------------------

  private extractNgrx(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const actionNames = new Set<string>();
    NGRX_CREATE_ACTION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NGRX_CREATE_ACTION.exec(content)) !== null) {
      const [, varName, actionType] = match;
      actionNames.add(varName);
      const nodeId = `ngrx_action_${sanitizedPath}_${varName}`;
      if (!seenNodeIds.has(nodeId)) {
        seenNodeIds.add(nodeId);
        nodes.push(this.createNode(
          nodeId, varName, 'ngrx_action', 4, relativePath, undefined, undefined,
          { library: 'ngrx', action_type: actionType }
        ));
        if (fileNodeId) {
          edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
        }
      }
    }

    NGRX_CREATE_REDUCER.lastIndex = 0;
    while ((match = NGRX_CREATE_REDUCER.exec(content)) !== null) {
      const reducerName = match[1];
      const nodeId = `ngrx_reducer_${sanitizedPath}_${reducerName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      nodes.push(this.createNode(
        nodeId, reducerName, 'ngrx_reducer', 3, relativePath, undefined, undefined,
        { library: 'ngrx', handles_actions: Array.from(actionNames), subcategories: ['frontend-state-store', 'ngrx'] }
      ));
      if (fileNodeId) {
        edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
      }
      for (const action of actionNames) {
        edges.push(this.createEdge(
          `edge_ngrx_mutates_${sanitizedPath}_${reducerName}_${action}`,
          nodeId, `ngrx_action_${sanitizedPath}_${action}`, 'mutates', 'behavioral', { action }
        ));
      }
    }

    NGRX_CREATE_EFFECT.lastIndex = 0;
    while ((match = NGRX_CREATE_EFFECT.exec(content)) !== null) {
      const effectName = match[1];
      const nodeId = `ngrx_effect_${sanitizedPath}_${effectName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);
      const line = content.slice(0, match.index).split(/\r?\n/).length;

      nodes.push(this.createNode(
        nodeId, effectName, 'ngrx_effect', 4, relativePath, undefined, undefined,
        { library: 'ngrx', side_effect: true }
      ));
      exitPoints.push(this.createExitPoint(
        `exit_ngrx_effect_${sanitizedPath}_${effectName}_${line}`,
        nodeId, 'event',
        `NgRx effect: ${effectName}`,
        `NgRx side-effect handler ${effectName} runs in response to dispatched actions in ${relativePath}.`,
        { service_id: 'ngrx', resource: effectName },
        { action: 'effect', async: true },
        { library: 'ngrx', effect: effectName, file: relativePath, line }
      ));
    }

    NGRX_CREATE_SELECTOR.lastIndex = 0;
    while ((match = NGRX_CREATE_SELECTOR.exec(content)) !== null) {
      const selectorName = match[1];
      const nodeId = `ngrx_selector_${sanitizedPath}_${selectorName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);
      nodes.push(this.createNode(
        nodeId, selectorName, 'ngrx_selector', 4, relativePath, undefined, undefined,
        { library: 'ngrx', memoized: true }
      ));
    }

    const selectSinks = (regex: RegExp, action: string) => {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        const name = m[1];
        const line = content.slice(0, m.index).split(/\r?\n/).length;
        exitPoints.push(this.createExitPoint(
          `exit_ngrx_${action}_${sanitizedPath}_${name}_${line}`,
          fileNodeId || `ngrx_${sanitizedPath}`,
          'event',
          `NgRx ${action}: ${name}`,
          `Component ${action}s ${name} via the NgRx store in ${relativePath}.`,
          { service_id: 'ngrx', resource: name },
          { action, async: action === 'select' },
          { library: 'ngrx', target: name, file: relativePath, line }
        ));
      }
    };
    selectSinks(NGRX_STORE_SELECT, 'select');
    selectSinks(NGRX_STORE_DISPATCH, 'dispatch');
  }

  // ---- XState ------------------------------------------------------------
  //
  // The architecture-defining-library analyzer (architectural-library-analyzer.ts)
  // already flags bare XState usage patterns (machine/transition/interpreter
  // regex hits) as generic library-usage nodes for convention guidance. This
  // extractor is complementary, not a duplicate: it builds the actual state
  // machine as a first-class node — states, events, and the send()/subscribe()
  // mutation and subscription surface — so agents can answer "what transitions
  // this machine" / "who subscribes to its state changes", the same blast-radius
  // question the mission asks for other frontend-state stores.

  private extractXState(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    const machineNames = new Set<string>();

    XSTATE_CREATE_MACHINE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = XSTATE_CREATE_MACHINE.exec(content)) !== null) {
      const machineName = match[1];
      machineNames.add(machineName);
      const nodeId = `xstate_machine_${sanitizedPath}_${machineName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const machineBody = this.extractBraceBlock(content, new RegExp(
        `${machineName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*createMachine\\s*(?:<[^>]*>)?\\s*\\(\\s*\\{`
      )) || '';
      const statesBlock = this.extractBraceBlock(machineBody, /states\s*:\s*\{/) || '';

      const states = new Set<string>();
      XSTATE_STATE_KEY.lastIndex = 0;
      let stateMatch: RegExpExecArray | null;
      while ((stateMatch = XSTATE_STATE_KEY.exec(statesBlock)) !== null) states.add(stateMatch[1]);

      const events = new Set<string>();
      XSTATE_EVENT_KEY.lastIndex = 0;
      let eventBlockMatch: RegExpExecArray | null;
      while ((eventBlockMatch = XSTATE_EVENT_KEY.exec(statesBlock)) !== null) {
        XSTATE_EVENT_NAME.lastIndex = 0;
        let eventNameMatch: RegExpExecArray | null;
        while ((eventNameMatch = XSTATE_EVENT_NAME.exec(eventBlockMatch[1])) !== null) events.add(eventNameMatch[1]);
      }

      nodes.push(this.createNode(
        nodeId, machineName, 'xstate_machine', 3, relativePath, undefined, undefined,
        {
          library: 'xstate',
          states: Array.from(states),
          events: Array.from(events),
          subcategories: ['frontend-state-store', 'state-machine', 'xstate'],
        }
      ));
      if (fileNodeId) {
        edges.push(this.createEdge(`edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'));
      }
      for (const event of events) {
        edges.push(this.createEdge(
          `edge_xstate_mutates_${sanitizedPath}_${machineName}_${event}`,
          nodeId, nodeId, 'mutates', 'behavioral', { action: event }
        ));
      }
    }

    if (machineNames.size === 0) return;

    // useMachine(machineRef) binds a local `send` (or `[, send]`) to a known
    // machine — every later send(...) or actorVar.send(...) call is then a
    // mutation sink for that machine's transition surface.
    const sendBindings = new Map<string, string>(); // send-var name -> machine name
    XSTATE_USE_MACHINE.lastIndex = 0;
    while ((match = XSTATE_USE_MACHINE.exec(content)) !== null) {
      const sendVar = match[1] || match[2];
      const machineName = match[3];
      if (sendVar && machineNames.has(machineName)) sendBindings.set(sendVar, machineName);
    }

    XSTATE_SEND.lastIndex = 0;
    while ((match = XSTATE_SEND.exec(content)) !== null) {
      const receiver = match[1];
      const machineName = receiver ? sendBindings.get(receiver) : (sendBindings.size === 1 ? [...sendBindings.values()][0] : undefined);
      if (!machineName) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      exitPoints.push(this.createExitPoint(
        `exit_xstate_send_${sanitizedPath}_${machineName}_${line}`,
        `xstate_machine_${sanitizedPath}_${machineName}`,
        'event',
        `XState send: ${machineName}`,
        `A transition event is sent to XState machine ${machineName} in ${relativePath}.`,
        { service_id: 'xstate', resource: machineName },
        { action: 'send', async: false },
        { library: 'xstate', machine: machineName, file: relativePath, line }
      ));
    }

    XSTATE_SUBSCRIBE.lastIndex = 0;
    while ((match = XSTATE_SUBSCRIBE.exec(content)) !== null) {
      const receiver = match[1];
      if (!machineNames.has(receiver)) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      exitPoints.push(this.createExitPoint(
        `exit_xstate_subscribe_${sanitizedPath}_${receiver}_${line}`,
        `xstate_machine_${sanitizedPath}_${receiver}`,
        'event',
        `XState subscribe: ${receiver}`,
        `${relativePath} subscribes to state changes of XState machine ${receiver}.`,
        { service_id: 'xstate', resource: receiver },
        { action: 'subscribe', async: true },
        { library: 'xstate', machine: receiver, file: relativePath, line }
      ));
    }
  }

  // ---- shared helpers ---------------------------------------------------------

  private addSimpleStateNode(
    nodes: CASNode[], edges: CASEdge[], seenNodeIds: Set<string>,
    opts: { nodeId: string; name: string; relativePath: string; fileNodeId?: string; nodeType: string; library: string }
  ): void {
    if (seenNodeIds.has(opts.nodeId)) return;
    seenNodeIds.add(opts.nodeId);
    nodes.push(this.createNode(
      opts.nodeId, opts.name, opts.nodeType, 3, opts.relativePath, undefined, undefined,
      { library: opts.library, subcategories: ['frontend-state-store', opts.library] }
    ));
    if (opts.fileNodeId) {
      edges.push(this.createEdge(`edge_${opts.nodeId}_${opts.fileNodeId}`, opts.nodeId, opts.fileNodeId, 'defined_in', 'structural'));
    }
  }

  private addMutationSinks(
    content: string, regex: RegExp, knownNames: Set<string>,
    sanitizedPath: string, relativePath: string, fileNodeId: string | undefined,
    nodes: CASNode[], exitPoints: CASExitPoint[], library: string, hookName: string
  ): void {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!knownNames.has(name)) continue;
      const line = content.slice(0, match.index).split(/\r?\n/).length;
      const sourceNode = nodes.find(n => n.source?.file === relativePath && n.name === name)?.id || fileNodeId || `${library}_${sanitizedPath}`;
      exitPoints.push(this.createExitPoint(
        `exit_${library}_${hookName}_${sanitizedPath}_${name}_${line}`,
        sourceNode,
        'event',
        `${library} ${hookName}: ${name}`,
        `${name} is read/subscribed via ${hookName}() in ${relativePath}.`,
        { service_id: library, resource: name },
        { action: hookName, async: false },
        { library, target: name, file: relativePath, line }
      ));
    }
  }

  private async hasNpmDependency(projectPath: string, names: string[]): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;
      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return names.some(name => name in deps);
    } catch {
      return false;
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
    return [
      'mobx-store-detection',
      'recoil-atom-selector-detection',
      'jotai-atom-detection',
      'valtio-proxy-detection',
      'pinia-store-detection',
      'ngrx-reducer-effect-selector-detection',
      'state-mutation-surface-detection',
    ];
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
