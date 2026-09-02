export interface RailsControllerCallback {
  name: string;
  only: string[];
  except: string[];
  line: number;
  sourceFile?: string;
  owner?: string;
  inherited?: boolean;
}

export interface RailsCallbackInvocation { name: string; only: string[]; except: string[]; line: number; }

export interface RailsControllerSecurityDefinition {
  name: string;
  qualifiedName?: string;
  filePath: string;
  beforeActions: RailsControllerCallback[];
  skipBeforeActions: RailsControllerCallback[];
  parentName?: string;
  includedConcerns: string[];
  callbackInvocations: RailsCallbackInvocation[];
}

export interface RailsSecurityMixin {
  name: string;
  filePath: string;
  beforeActions: RailsControllerCallback[];
  skipBeforeActions: RailsControllerCallback[];
  includedConcerns: string[];
  skipMacros: Array<{ name: string; filterName: string }>;
}

type SymbolListExtractor = (options: string, key: string) => string[];

export function railsIncludedModules(content: string): string[] {
  const modules: string[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].trim().match(/^(?:include|prepend)\s+(.+)$/);
    if (!match) continue;
    let expression = match[1];
    while (expression.trimEnd().endsWith(',') && index + 1 < lines.length) expression += ' ' + lines[++index].trim();
    modules.push(...expression.split(',').map(value => value.trim()).filter(value => /^[A-Z]\w*(?:::[A-Z]\w*)*$/.test(value)));
  }
  return [...new Set(modules)];
}

function parseCallbacks(content: string, filePath: string, owner: string, extractSymbols: SymbolListExtractor) {
  const beforeActions: RailsControllerCallback[] = [];
  const skipBeforeActions: RailsControllerCallback[] = [];
  const includedConcerns: string[] = [];
  let classMethodsDepth = 0;
  for (const [index, sourceLine] of content.split('\n').entries()) {
    const line = sourceLine.trim();
    if (/^class_methods\s+do$/.test(line)) { classMethodsDepth = 1; continue; }
    if (classMethodsDepth > 0) {
      if (/^(?:def\b|.*\bdo)$/.test(line)) classMethodsDepth += 1;
      if (/^end$/.test(line)) classMethodsDepth -= 1;
      continue;
    }
    const callback = line.match(/^(before_action|before_filter)\s+:(\w+[?!]?)(.*)$/);
    if (callback) {
      const options = callback[3] || '';
      beforeActions.push({ name: callback[2], only: extractSymbols(options, 'only'), except: extractSymbols(options, 'except'), line: index + 1, sourceFile: filePath, owner });
      continue;
    }
    const skip = line.match(/^skip_(?:before_action|before_filter)\s+:(\w+[?!]?)(.*)$/);
    if (skip) {
      const options = skip[2] || '';
      skipBeforeActions.push({ name: skip[1], only: extractSymbols(options, 'only'), except: extractSymbols(options, 'except'), line: index + 1, sourceFile: filePath, owner });
      continue;
    }
    const included = line.match(/^(?:include|prepend)\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*$/);
    if (included) includedConcerns.push(included[1]);
  }
  return { beforeActions, skipBeforeActions, includedConcerns: railsIncludedModules(content) };
}

export function extractRailsSecurityMixin(content: string, filePath: string, extractSymbols: SymbolListExtractor): RailsSecurityMixin | undefined {
  const declared = content.match(/^\s*module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/m)?.[1];
  if (!declared) return undefined;
  const parsed = parseCallbacks(content, filePath, declared, extractSymbols);
  const skipMacros = [...content.matchAll(/def\s+(\w+)[^\n]*\n[\s\S]*?skip_(?:before_action|before_filter)\s+:(\w+[?!]?)[\s\S]*?^\s*end\s*$/gm)].map(match => ({ name: match[1], filterName: match[2] }));
  return { name: declared, filePath, ...parsed, skipMacros };
}

export function railsCallbackApplies(callback: Pick<RailsControllerCallback, 'only' | 'except'>, action: string): boolean {
  return (callback.only.length === 0 || callback.only.includes(action)) && !callback.except.includes(action);
}

export function resolveRailsControllerSecurity(
  controllers: RailsControllerSecurityDefinition[],
  concerns: RailsSecurityMixin[],
): void {
  const controllerByName = new Map(controllers.map(controller => [controller.qualifiedName || controller.name, controller]));
  const controllersByLeaf = new Map<string, RailsControllerSecurityDefinition[]>();
  for (const controller of controllers) controllersByLeaf.set(controller.name, [...(controllersByLeaf.get(controller.name) || []), controller]);
  const concernByName = new Map(concerns.flatMap(concern => [[concern.name, concern], [concern.name.split('::').pop() || concern.name, concern]]));
  const resolving = new Set<string>();
  const resolvedControllers = new Set<string>();

  const concernCallbacks = (name: string, trail = new Set<string>()): { before: RailsControllerCallback[]; skips: RailsControllerCallback[] } => {
    const concern = concernByName.get(name);
    if (!concern || trail.has(concern.name)) return { before: [], skips: [] };
    const nextTrail = new Set(trail).add(concern.name);
    const inherited = concern.includedConcerns.flatMap(child => {
      const nested = concernCallbacks(child, nextTrail);
      return [...nested.before.map(item => ({ kind: 'before' as const, item })), ...nested.skips.map(item => ({ kind: 'skip' as const, item }))];
    });
    return {
      before: [...inherited.filter(item => item.kind === 'before').map(item => item.item), ...concern.beforeActions],
      skips: [...inherited.filter(item => item.kind === 'skip').map(item => item.item), ...concern.skipBeforeActions],
    };
  };

  const resolve = (controller: RailsControllerSecurityDefinition): void => {
    const identity = controller.qualifiedName || controller.name;
    if (resolvedControllers.has(identity) || resolving.has(identity)) return;
    resolving.add(identity);
    const leafParents = controller.parentName ? controllersByLeaf.get(controller.parentName.split('::').pop() || controller.parentName) || [] : [];
    const parent = controller.parentName ? controllerByName.get(controller.parentName) || (leafParents.length === 1 ? leafParents[0] : undefined) : undefined;
    const directIncludedConcerns = [...controller.includedConcerns];
    if (parent) resolve(parent);
    controller.includedConcerns = [...new Set([...(parent?.includedConcerns || []), ...controller.includedConcerns])];
    const includedDefinitions = controller.includedConcerns.map(name => concernByName.get(name)).filter((item): item is RailsSecurityMixin => Boolean(item));
    const included = directIncludedConcerns.map(name => concernCallbacks(name));
    controller.beforeActions = [
      ...(parent?.beforeActions || []).map(item => ({ ...item, inherited: true })),
      ...included.flatMap(item => item.before).map(item => ({ ...item, inherited: true })),
      ...controller.beforeActions,
    ];
    controller.skipBeforeActions = [
      ...(parent?.skipBeforeActions || []).map(item => ({ ...item, inherited: true })),
      ...included.flatMap(item => item.skips).map(item => ({ ...item, inherited: true })),
      ...controller.skipBeforeActions,
      ...controller.callbackInvocations.flatMap(invocation => includedDefinitions.flatMap(concern => concern.skipMacros
        .filter(macro => macro.name === invocation.name)
        .map(macro => ({ name: macro.filterName, only: invocation.only, except: invocation.except, line: invocation.line, sourceFile: controller.filePath, owner: controller.name })))),
    ];
    resolving.delete(identity);
    resolvedControllers.add(identity);
  };
  controllers.forEach(resolve);
}
