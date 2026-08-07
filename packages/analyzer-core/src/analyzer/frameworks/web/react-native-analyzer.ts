import { BaseAnalyzer, AnalysisContext, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, CASPerspective } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * React Native / Expo framework analyzer.
 *
 * React Native screens are React components, but rendered with native
 * primitives (View/Text/ScrollView/FlatList) instead of DOM elements, and the
 * app's structure is expressed through three additional, mobile-specific
 * surfaces that the web React analyzer does not model:
 *
 *  - Expo Router file-based routes under app/**\/*.tsx (like Next.js pages).
 *  - React Navigation navigators (Stack/Tab/Drawer) plus their registered
 *    <Stack.Screen name component /> and imperative navigation.navigate('X')
 *    calls — this is the app's screen flow, the highest-value signal.
 *  - Native capability surface: imports of expo-* modules and react-native
 *    NativeModules, i.e. which device features the app touches.
 */

// React Native core primitive components that mark a function as a screen/view.
const RN_PRIMITIVES = [
  'View', 'Text', 'ScrollView', 'FlatList', 'SectionList', 'SafeAreaView',
  'TouchableOpacity', 'TouchableHighlight', 'Pressable', 'Image', 'TextInput',
  'Button', 'Modal', 'KeyboardAvoidingView', 'ImageBackground', 'VirtualizedList',
];

const NAVIGATOR_FACTORIES = [
  'createStackNavigator',
  'createNativeStackNavigator',
  'createBottomTabNavigator',
  'createMaterialTopTabNavigator',
  'createMaterialBottomTabNavigator',
  'createDrawerNavigator',
];

interface RNComponent {
  name: string;
  filePath: string; // relative
  type: 'functional' | 'class';
  isScreen: boolean; // renders RN primitives or located under screens/
  primitivesUsed: string[];
  rendersComponents: string[];
}

interface ExpoRoute {
  routePath: string; // e.g. /, /profile/:id
  filePath: string; // relative
  kind: 'route' | 'layout';
  dynamicParams: string[];
  groups: string[];
}

interface NavigatorRegistration {
  navigatorVar: string | null; // e.g. Stack
  navigatorKind: string; // stack | tab | drawer | native-stack | ...
  screenName: string;
  componentName: string | null;
  filePath: string;
  line: number;
}

interface NavigateCall {
  targetScreen: string;
  filePath: string;
  line: number;
}

interface NativeCapability {
  module: string; // e.g. expo-camera or NativeModules.X
  filePath: string;
  feature: string; // camera, location, ...
}

export class ReactNativeAnalyzer extends BaseAnalyzer {
  constructor() {
    super('react-native', 'React Native / Expo Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath).catch(() => ({}));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(d => d === 'react-native' || d === 'expo' || d === 'expo-router')) {
          return true;
        }
      }

      // Expo app config presence is a strong RN signal even without package.json deps resolved.
      const configFiles = ['app.json', 'app.config.js', 'app.config.ts', 'app.config.json'];
      for (const cfg of configFiles) {
        if (await fs.pathExists(path.join(projectPath, cfg))) {
          // app.json is also used by other tooling; require an `expo` key OR a react-native import.
          if (cfg === 'app.json') {
            const parsed = await fs.readJson(path.join(projectPath, cfg)).catch(() => null);
            if (parsed && (parsed.expo || parsed.name)) {
              const hasRn = await this.anyFileImportsReactNative(projectPath);
              if (parsed.expo || hasRn) return true;
            }
            continue;
          }
          return true;
        }
      }

      return await this.anyFileImportsReactNative(projectPath);
    } catch {
      return false;
    }
  }

  private async anyFileImportsReactNative(projectPath: string): Promise<boolean> {
    try {
      const files = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true,
      });
      for (const file of files.slice(0, 400)) {
        const content = await this.readTextFileIfExists(path.join(projectPath, file));
        if (content === null) continue;
        if (/from\s+['"]react-native['"]/.test(content) ||
            /from\s+['"]expo-router['"]/.test(content) ||
            /from\s+['"]@react-navigation\//.test(content)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    return glob(['**/*.{ts,tsx,js,jsx}'], {
      cwd: projectPath,
      ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
      nodir: true,
    });
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const file = context.relativePath;

    const content = await this.readTextFileIfExists(context.filePath);
    if (content === null) {
      return this.createFileAnalysisResult(
        context.filePath, file, context.contentHash || this.computeContentHash(''),
        Date.now(), nodes, edges, entryPoints, exitPoints, [], []
      );
    }
    const stat = await fs.stat(context.filePath);

    // Per-file extraction. Expo routes are derived purely from the file path,
    // so a single file is enough to attribute its own route/layout/screens.
    const components = this.extractComponents(content, file);
    this.emitComponents(components, context.projectPath, nodes, edges);

    const route = this.deriveExpoRoute(file);
    if (route) this.emitExpoRoute(route, context.projectPath, nodes, entryPoints);

    const registrations = this.extractNavigatorRegistrations(content, file);
    const navigateCalls = this.extractNavigateCalls(content, file);
    this.emitNavigation(registrations, navigateCalls, context.projectPath, nodes, edges, exitPoints);

    const capabilities = this.extractNativeCapabilities(content, file);
    this.emitNativeCapabilities(capabilities, context.projectPath, nodes);

    this.tagNodesWithPerspectives(nodes, edges);

    return this.createFileAnalysisResult(
      context.filePath, file, context.contentHash || this.computeContentHash(content),
      stat.mtimeMs, nodes, edges, entryPoints, exitPoints,
      this.extractImports(content), this.extractExports(content)
    );
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const perspectives: CASPerspective[] = [];

    try {
      const ignore = [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'];
      const files = this.capAndPrioritizeSourceFiles(
        await glob(['**/*.{ts,tsx,js,jsx}'], { cwd: context.projectPath, ignore, nodir: true }),
        'React Native source files'
      );

      const allRegistrations: NavigatorRegistration[] = [];
      const allNavigateCalls: NavigateCall[] = [];
      let screenCount = 0;
      let routeCount = 0;
      const capabilitySet = new Set<string>();

      for (const file of files) {
        const content = await this.readTextFileIfExists(path.join(context.projectPath, file));
        if (content === null) continue;

        const components = this.extractComponents(content, file);
        screenCount += components.filter(c => c.isScreen).length;
        this.emitComponents(components, context.projectPath, nodes, edges);

        const route = this.deriveExpoRoute(file);
        if (route) {
          routeCount++;
          this.emitExpoRoute(route, context.projectPath, nodes, entryPoints);
        }

        const registrations = this.extractNavigatorRegistrations(content, file);
        const navigateCalls = this.extractNavigateCalls(content, file);
        allRegistrations.push(...registrations);
        allNavigateCalls.push(...navigateCalls);

        const capabilities = this.extractNativeCapabilities(content, file);
        capabilities.forEach(c => capabilitySet.add(c.module));
        this.emitNativeCapabilities(capabilities, context.projectPath, nodes);
      }

      this.emitNavigation(allRegistrations, allNavigateCalls, context.projectPath, nodes, edges, exitPoints);

      this.createPerspectives(perspectives);
      this.tagNodesWithPerspectives(nodes, edges);

      const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          react_native_version: await this.getPackageVersion(context.projectPath, 'react-native'),
          expo_version: await this.getPackageVersion(context.projectPath, 'expo'),
          screens_detected: screenCount,
          expo_routes_detected: routeCount,
          navigator_registrations: allRegistrations.length,
          navigate_calls: allNavigateCalls.length,
          native_capabilities: Array.from(capabilitySet),
        },
      });
      contribution.perspectives = perspectives;
      contribution.provided_perspectives = perspectives.map(p => p.id);
      return contribution;
    } catch (error) {
      throw new AnalyzerError(
        `React Native analysis failed: ${(error as Error).message}`,
        'REACT_NATIVE_ANALYSIS_ERROR'
      );
    }
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return `level_${level}`;
    }
  }

  protected getCapabilities(): string[] {
    return ['rn-screens', 'expo-router', 'rn-navigation', 'expo-native-modules'];
  }

  // ---------------------------------------------------------------------------
  // Component / screen detection
  // ---------------------------------------------------------------------------

  private extractComponents(content: string, file: string): RNComponent[] {
    const components: RNComponent[] = [];
    const seen = new Set<string>();
    const importsRn = /from\s+['"]react-native['"]/.test(content);
    const underScreensDir = /(^|\/)screens?\//.test(file);
    const looksLikeScreenName = (name: string) => /(Screen|Page|View|Tab)$/.test(name);

    const considerComponent = (name: string, bodyStart: number, bodyEnd: number) => {
      if (!name || !/^[A-Z]/.test(name) || seen.has(name)) return;
      const body = content.substring(bodyStart, bodyEnd);
      // Must be a component: returns JSX.
      if (!(body.includes('return') && (body.includes('<') || body.includes('createElement')))) return;

      const primitivesUsed = RN_PRIMITIVES.filter(p =>
        new RegExp(`<${p}[\\s/>]`).test(body)
      );
      const rendersComponents = this.extractRenderedComponentNames(body);
      const isScreen = primitivesUsed.length > 0 || underScreensDir || looksLikeScreenName(name);
      // Only count as an RN component if the file uses RN, is under screens/, or
      // the function actually renders RN primitives. Avoids grabbing plain TS.
      if (!importsRn && !underScreensDir && primitivesUsed.length === 0) return;

      seen.add(name);
      components.push({
        name,
        filePath: file,
        type: 'functional',
        isScreen,
        primitivesUsed,
        rendersComponents,
      });
    };

    // function Foo() {...}
    const fnDecl = /function\s+([A-Z]\w*)\s*\([^)]*\)\s*(?::[^={]+)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = fnDecl.exec(content)) !== null) {
      const bodyStart = m.index + m[0].length;
      considerComponent(m[1], bodyStart, this.matchingBraceEnd(content, m.index + m[0].length - 1));
    }

    // const Foo = (...) => {...}  OR  const Foo: React.FC = (...) => {...}
    const arrowDecl = /(?:const|let|var)\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>\s*[({]/g;
    while ((m = arrowDecl.exec(content)) !== null) {
      const after = content.substring(m.index + m[0].length - 1);
      const bodyStart = m.index + m[0].length - 1;
      const bodyEnd = after.startsWith('{')
        ? this.matchingBraceEnd(content, bodyStart)
        : this.matchingParenEnd(content, bodyStart);
      considerComponent(m[1], bodyStart, bodyEnd);
    }

    // class Foo extends React.Component / Component
    const classDecl = /class\s+([A-Z]\w*)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/g;
    while ((m = classDecl.exec(content)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      const bodyEnd = this.matchingBraceEnd(content, content.indexOf('{', m.index));
      const body = content.substring(m.index, bodyEnd);
      const primitivesUsed = RN_PRIMITIVES.filter(p => new RegExp(`<${p}[\\s/>]`).test(body));
      if (!importsRn && !underScreensDir && primitivesUsed.length === 0) continue;
      seen.add(name);
      components.push({
        name, filePath: file, type: 'class',
        isScreen: primitivesUsed.length > 0 || underScreensDir || looksLikeScreenName(name),
        primitivesUsed,
        rendersComponents: this.extractRenderedComponentNames(body),
      });
    }

    return components;
  }

  private emitComponents(components: RNComponent[], projectPath: string, nodes: CASNode[], edges: CASEdge[]): void {
    const idByName = new Map<string, string>();
    for (const c of components) {
      idByName.set(c.name, this.generateId(c.isScreen ? 'rn_screen' : 'rn_component', c.filePath, c.name));
    }
    for (const c of components) {
      const fullPath = path.join(projectPath, c.filePath);
      const id = this.generateId(c.isScreen ? 'rn_screen' : 'rn_component', c.filePath, c.name);
      const type = c.isScreen ? 'rn-screen' : (c.type === 'class' ? 'class_component' : 'functional_component');
      const node = this.createNodeBuilder(id, c.name, type)
        .withLevel(2, 'architectural')
        .withCategory(c.isScreen ? 'screen' : 'component', ['react-native', c.isScreen ? 'screen' : 'component'])
        .withSource({ file: c.filePath, line: 1 })
        .withDescription(c.isScreen
          ? `React Native screen: ${c.name}`
          : `React Native component: ${c.name}`)
        .withTags([`analyzer:${this.analyzerId}`, c.isScreen ? 'rn-screen' : 'rn-component'])
        .withMetadata({
          framework: 'react-native',
          attributes: {
            component_type: c.type,
            is_screen: c.isScreen,
            primitives_used: c.primitivesUsed,
            renders_components: c.rendersComponents,
          },
        })
        .build();
      nodes.push(node);
    }

    // Component tree: a component's rendered children (rendersComponents) that
    // resolve to a known component get a `renders` edge — the Camp-C composition
    // fact (import/structural indexers see only the import). RN primitives
    // (View/Text/…) aren't components, so they naturally drop out of the map.
    for (const c of components) {
      const parentId = idByName.get(c.name);
      if (!parentId) continue;
      for (const child of c.rendersComponents) {
        const childId = idByName.get(child);
        if (!childId || childId === parentId) continue;
        const edgeId = this.generateEdgeId(parentId, childId, 'renders');
        if (edges.some(e => e.id === edgeId)) continue;
        edges.push(this.createEdge(edgeId, parentId, childId, 'renders', 'component-tree', {
          framework: 'react-native',
        }));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Expo Router (file-based routing)
  // ---------------------------------------------------------------------------

  private deriveExpoRoute(file: string): ExpoRoute | null {
    const normalized = file.replace(/\\/g, '/');
    // Match an `app/` dir anywhere (monorepo-safe) followed by the route file.
    const match = normalized.match(/(?:^|\/)app\/(.*)$/);
    if (!match) return null;
    const rel = match[1]; // e.g. (tabs)/profile/[id].tsx, index.tsx, _layout.tsx
    if (!/\.(tsx|jsx|ts|js)$/.test(rel)) return null;

    const segments = rel.split('/');
    const fileSeg = segments[segments.length - 1];
    const base = fileSeg.replace(/\.(tsx|jsx|ts|js)$/, '');
    const isLayout = base === '_layout';
    // +html, +not-found etc. and api route handlers are still routes; skip private dirs.
    const dynamicParams: string[] = [];
    const groups: string[] = [];

    const routeSegments: string[] = [];
    const allSegs = [...segments.slice(0, -1), base];
    for (const seg of allSegs) {
      if (!seg) continue;
      const groupMatch = seg.match(/^\((.+)\)$/);
      if (groupMatch) { groups.push(groupMatch[1]); continue; } // route groups don't appear in URL
      const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
      if (catchAll) { dynamicParams.push(catchAll[1]); routeSegments.push('*'); continue; }
      const dyn = seg.match(/^\[(.+)\]$/);
      if (dyn) { dynamicParams.push(dyn[1]); routeSegments.push(`:${dyn[1]}`); continue; }
      if (seg === 'index' || seg === '_layout') continue;
      routeSegments.push(seg);
    }

    const routePath = '/' + routeSegments.join('/');
    return {
      routePath: routePath === '/' ? '/' : routePath.replace(/\/$/, ''),
      filePath: file,
      kind: isLayout ? 'layout' : 'route',
      dynamicParams,
      groups,
    };
  }

  private emitExpoRoute(route: ExpoRoute, projectPath: string, nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
    const fullPath = path.join(projectPath, route.filePath);
    if (route.kind === 'layout') {
      const id = this.generateId('expo_layout', route.filePath, route.routePath || 'root');
      nodes.push(this.createNodeBuilder(id, `Layout ${route.routePath || '/'}`, 'layout')
        .withLevel(2, 'architectural')
        .withCategory('layout', ['react-native', 'expo-router'])
        .withSource({ file: route.filePath, line: 1 })
        .withDescription(`Expo Router layout for ${route.routePath || '/'}`)
        .withTags([`analyzer:${this.analyzerId}`, 'expo-router'])
        .withMetadata({ framework: 'react-native', attributes: { routePath: route.routePath, groups: route.groups, router: 'expo-router' } })
        .build());
      return;
    }

    const id = this.generateId('expo_route', route.filePath, route.routePath);
    nodes.push(this.createNodeBuilder(id, `Route ${route.routePath}`, 'route')
      .withLevel(3, 'code')
      .withCategory('route', ['react-native', 'expo-router', 'navigation'])
      .withSource({ file: route.filePath, line: 1 })
      .withDescription(`Expo Router screen at ${route.routePath}`)
      .withTags([`analyzer:${this.analyzerId}`, 'expo-router'])
      .withMetadata({
        framework: 'react-native',
        attributes: {
          routePath: route.routePath,
          router: 'expo-router',
          dynamicParams: route.dynamicParams,
          groups: route.groups,
        },
      })
      .build());

    entryPoints.push(this.createEntryPoint(
      `entry_${id}`,
      id,
      'route',
      `SCREEN ${route.routePath}`,
      `Expo Router file-based route at ${route.routePath}`,
      { path: route.routePath, method: 'NAVIGATE' },
      { authenticated: false },
      { framework: 'react-native', router: 'expo-router', routeFile: route.filePath }
    ));
  }

  // ---------------------------------------------------------------------------
  // React Navigation
  // ---------------------------------------------------------------------------

  private extractNavigatorRegistrations(content: string, file: string): NavigatorRegistration[] {
    const regs: NavigatorRegistration[] = [];

    // Map navigator variable -> kind from `const Stack = createStackNavigator()`.
    const navigatorVars = new Map<string, string>();
    const factoryPattern = new RegExp(
      `(?:const|let|var)\\s+(\\w+)\\s*=\\s*(${NAVIGATOR_FACTORIES.join('|')})\\s*\\(`,
      'g'
    );
    let fm: RegExpExecArray | null;
    while ((fm = factoryPattern.exec(content)) !== null) {
      navigatorVars.set(fm[1], this.navigatorKind(fm[2]));
    }

    // <Stack.Screen name="Home" component={HomeScreen} /> (attributes any order)
    const screenTag = /<(\w+)\.Screen\b([^>]*?)\/?>/g;
    let sm: RegExpExecArray | null;
    while ((sm = screenTag.exec(content)) !== null) {
      const navVar = sm[1];
      const attrs = sm[2];
      const nameMatch = attrs.match(/name\s*=\s*(?:["']([^"']+)["']|\{\s*["']([^"']+)["']\s*\})/);
      if (!nameMatch) continue;
      const screenName = nameMatch[1] || nameMatch[2];
      const compMatch = attrs.match(/component\s*=\s*\{?\s*(\w+)/);
      const line = content.substring(0, sm.index).split('\n').length;
      regs.push({
        navigatorVar: navVar,
        navigatorKind: navigatorVars.get(navVar) || 'stack',
        screenName,
        componentName: compMatch ? compMatch[1] : null,
        filePath: file,
        line,
      });
    }

    // Static config style: Stack.Navigator screens={{ Home: HomeScreen }} or
    // createXNavigator({ Home: { screen: HomeScreen } }) — best-effort.
    const objScreen = /(\w+)\s*:\s*\{\s*screen\s*:\s*(\w+)/g;
    if (navigatorVars.size > 0) {
      let om: RegExpExecArray | null;
      while ((om = objScreen.exec(content)) !== null) {
        const line = content.substring(0, om.index).split('\n').length;
        if (regs.some(r => r.screenName === om![1] && r.componentName === om![2])) continue;
        regs.push({
          navigatorVar: null,
          navigatorKind: 'stack',
          screenName: om[1],
          componentName: om[2],
          filePath: file,
          line,
        });
      }
    }

    return regs;
  }

  private extractNavigateCalls(content: string, file: string): NavigateCall[] {
    const calls: NavigateCall[] = [];
    const seen = new Set<string>();
    // navigation.navigate('Home'), navigation.push('Detail'), navigation.replace('X')
    const navPattern = /(?:navigation|nav|props\.navigation)\s*\.\s*(?:navigate|push|replace)\s*\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = navPattern.exec(content)) !== null) {
      const key = `${m[1]}@${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ targetScreen: m[1], filePath: file, line: content.substring(0, m.index).split('\n').length });
    }
    // Expo Router: router.push('/profile') / router.navigate('/x')
    const routerPattern = /router\s*\.\s*(?:push|replace|navigate)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = routerPattern.exec(content)) !== null) {
      const key = `${m[1]}@${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ targetScreen: m[1], filePath: file, line: content.substring(0, m.index).split('\n').length });
    }
    return calls;
  }

  private emitNavigation(
    registrations: NavigatorRegistration[],
    navigateCalls: NavigateCall[],
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[]
  ): void {
    // Index of screen-name -> registration node id, so navigate() edges can
    // target the registered screen.
    const screenNodeByName = new Map<string, string>();

    for (const reg of registrations) {
      const fullPath = path.join(projectPath, reg.filePath);
      const id = this.generateId('nav_screen', reg.filePath, `${reg.navigatorKind}_${reg.screenName}`);
      screenNodeByName.set(reg.screenName, id);
      nodes.push(this.createNodeBuilder(id, reg.screenName, 'navigation-screen')
        .withLevel(3, 'code')
        .withCategory('navigation', ['react-native', 'react-navigation', reg.navigatorKind])
        .withSource({ file: reg.filePath, line: reg.line })
        .withDescription(`React Navigation ${reg.navigatorKind} screen "${reg.screenName}"${reg.componentName ? ` -> ${reg.componentName}` : ''}`)
        .withTags([`analyzer:${this.analyzerId}`, 'rn-navigation'])
        .withMetadata({
          framework: 'react-native',
          attributes: {
            screen_name: reg.screenName,
            navigator: reg.navigatorVar,
            navigator_kind: reg.navigatorKind,
            component: reg.componentName,
          },
        })
        .build());

      // Edge: registered screen -> the component it renders (if resolvable in this run).
      if (reg.componentName) {
        const screenComponentId = this.generateId('rn_screen', reg.filePath, reg.componentName);
        const componentId = this.generateId('rn_component', reg.filePath, reg.componentName);
        // Prefer linking to a screen-typed node, fall back to component id; both
        // ids are deterministic so the graph stitches them if those nodes exist.
        edges.push(this.createEdge(
          this.generateEdgeId(id, screenComponentId, 'renders'),
          id, screenComponentId, 'renders', 'navigation',
          { framework: 'react-native', component: reg.componentName, fallback_target: componentId }
        ));
      }
    }

    // navigate('X') -> screen X. Source is a per-file navigation node.
    const seenEdge = new Set<string>();
    for (const call of navigateCalls) {
      const fullPath = path.join(projectPath, call.filePath);
      const sourceId = this.ensureNavigationSourceNode(call.filePath, nodes);
      const targetId = screenNodeByName.get(call.targetScreen);

      if (targetId) {
        const edgeId = this.generateEdgeId(sourceId, targetId, 'navigates');
        if (!seenEdge.has(edgeId)) {
          seenEdge.add(edgeId);
          edges.push(this.createEdge(
            edgeId, sourceId, targetId, 'navigates', 'navigation',
            { framework: 'react-native', target_screen: call.targetScreen, line: call.line }
          ));
        }
      } else {
        // Unresolved (e.g. Expo Router path or screen registered elsewhere):
        // record as a navigation exit point so the flow is still visible.
        const exitId = `exit_rn_nav_${this.sanitizeId(call.filePath)}_${this.sanitizeId(call.targetScreen)}`;
        if (!seenEdge.has(exitId)) {
          seenEdge.add(exitId);
          exitPoints.push(this.createExitPoint(
            exitId, sourceId, 'navigation', `NAVIGATE ${call.targetScreen}`,
            undefined, { endpoint: call.targetScreen }, undefined,
            { framework: 'react-native', sourceFile: call.filePath }
          ));
        }
      }
    }
  }

  private ensureNavigationSourceNode(relativePath: string, nodes: CASNode[]): string {
    const id = this.generateId('rn_nav_source', relativePath, 'navigation');
    if (nodes.some(n => n.id === id)) return id;
    nodes.push(this.createNodeBuilder(id, `Navigation ${relativePath}`, 'navigation-source')
      .withLevel(3, 'code')
      .withCategory('navigation', ['react-native', 'react-navigation'])
      .withSource({ file: relativePath, line: 1 })
      .withDescription(`Screen navigation source in ${relativePath}`)
      .withTags([`analyzer:${this.analyzerId}`, 'rn-navigation'])
      .withMetadata({ framework: 'react-native', attributes: { sourceFile: relativePath } })
      .build());
    return id;
  }

  private navigatorKind(factory: string): string {
    if (/Native/.test(factory) && /Stack/.test(factory)) return 'native-stack';
    if (/Stack/.test(factory)) return 'stack';
    if (/Drawer/.test(factory)) return 'drawer';
    if (/Tab/.test(factory)) return 'tab';
    return 'stack';
  }

  // ---------------------------------------------------------------------------
  // Native modules / Expo APIs
  // ---------------------------------------------------------------------------

  private extractNativeCapabilities(content: string, file: string): NativeCapability[] {
    const caps: NativeCapability[] = [];
    const seen = new Set<string>();

    // expo-* module imports (expo-camera, expo-location, etc.)
    const expoImport = /from\s+['"](expo-[\w-]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = expoImport.exec(content)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      caps.push({ module: m[1], filePath: file, feature: m[1].replace(/^expo-/, '') });
    }

    // expo named API surfaces: import { Camera } from 'expo-camera' already covered;
    // also `import * as Location from 'expo-location'` covered by the same regex.

    // NativeModules.X usage
    const nativeModule = /NativeModules\.(\w+)/g;
    while ((m = nativeModule.exec(content)) !== null) {
      const mod = `NativeModules.${m[1]}`;
      if (seen.has(mod)) continue;
      seen.add(mod);
      caps.push({ module: mod, filePath: file, feature: m[1] });
    }

    return caps;
  }

  private emitNativeCapabilities(caps: NativeCapability[], projectPath: string, nodes: CASNode[]): void {
    for (const cap of caps) {
      const fullPath = path.join(projectPath, cap.filePath);
      const id = this.generateId('rn_native_capability', cap.filePath, cap.module);
      nodes.push(this.createNodeBuilder(id, cap.module, 'native-capability')
        .withLevel(3, 'code')
        .withCategory('capability', ['react-native', 'expo', 'native-module'])
        .withSource({ file: cap.filePath, line: 1 })
        .withDescription(`Native device capability: ${cap.module} (${cap.feature})`)
        .withTags([`analyzer:${this.analyzerId}`, 'expo-native-modules', `capability:${cap.feature}`])
        .withMetadata({ framework: 'react-native', attributes: { module: cap.module, feature: cap.feature } })
        .build());
    }
  }

  // ---------------------------------------------------------------------------
  // Perspectives
  // ---------------------------------------------------------------------------

  private createPerspectives(perspectives: CASPerspective[]): void {
    perspectives.push({
      id: 'rn-navigation',
      name: 'React Native Screen Flow',
      description: 'Screens, navigators, and navigate() transitions showing the app navigation graph',
      analyzer_id: this.analyzerId,
      type: 'flow',
      connection_rules: {
        visible_node_types: ['rn-screen', 'navigation-screen', 'navigation-source', 'route', 'layout', 'functional_component', 'class_component'],
        relevant_edge_types: ['navigates', 'renders'],
        node_connections: [
          { from_type: 'navigation-source', to_types: ['navigation-screen', 'rn-screen'], edge_type: 'navigates' },
          { from_type: 'navigation-screen', to_types: ['rn-screen', 'functional_component'], edge_type: 'renders' },
        ],
      },
      layout_hints: { style: 'hierarchical', direction: 'TB' },
    });

    perspectives.push({
      id: 'rn-architecture',
      name: 'React Native Application Architecture',
      description: 'Screens, routes, components, and native capabilities of the mobile app',
      analyzer_id: this.analyzerId,
      type: 'structure',
      connection_rules: {
        visible_node_types: ['rn-screen', 'route', 'layout', 'functional_component', 'class_component', 'native-capability', 'navigation-screen'],
        relevant_edge_types: ['renders', 'navigates'],
      },
      layout_hints: { style: 'hierarchical', direction: 'LR' },
    });
  }

  private tagNodesWithPerspectives(nodes: CASNode[], edges: CASEdge[]): void {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (!node.perspectives) node.perspectives = {};

      const isScreen = node.type === 'rn-screen' || node.type === 'navigation-screen' || node.type === 'route';
      const isNav = node.type === 'navigation-source' || node.type === 'navigation-screen';

      if (isScreen || isNav) {
        node.perspectives['rn-navigation'] = {
          hierarchy: ['navigation', node.type, node.name],
          level: node.level || 2,
          priority: node.type === 'rn-screen' || node.type === 'route' ? 90 : 80,
        };
      }

      node.perspectives['rn-architecture'] = {
        hierarchy: ['architecture', node.category || node.type, node.name],
        level: node.level || 2,
        priority: isScreen ? 80 : 50,
      };
    }

    for (const edge of edges) {
      edge.perspectives = [];
      if (edge.type === 'navigates' || edge.type === 'renders') {
        edge.perspectives.push('rn-navigation');
        edge.perspectives.push('rn-architecture');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async readTextFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private extractRenderedComponentNames(body: string): string[] {
    const names = new Set<string>();
    const jsxPattern = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
    let m: RegExpExecArray | null;
    while ((m = jsxPattern.exec(body)) !== null) {
      if (RN_PRIMITIVES.includes(m[1])) continue;
      names.add(m[1]);
    }
    return Array.from(names);
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const importPattern = /import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importPattern.exec(content)) !== null) imports.push(m[1]);
    return imports;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportPattern = /export\s+(?:default\s+)?(?:const|function|class)?\s*(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = exportPattern.exec(content)) !== null) exports.push(m[1]);
    return exports;
  }

  /** Returns index just past the matching `}` for the `{` at or after startIdx. */
  private matchingBraceEnd(content: string, startIdx: number): number {
    let i = content.indexOf('{', startIdx);
    if (i === -1) return content.length;
    let depth = 0;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return content.length;
  }

  /** Returns index just past the matching `)` for the `(` at or after startIdx. */
  private matchingParenEnd(content: string, startIdx: number): number {
    let i = content.indexOf('(', startIdx);
    if (i === -1) return Math.min(content.length, startIdx + 2000);
    let depth = 0;
    for (; i < content.length; i++) {
      const ch = content[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
    }
    return content.length;
  }
}
