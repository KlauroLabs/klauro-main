import { railsIncludedModules } from './rails-controller-security';

export interface RailsResolvedAction<TAccess> {
  name: string;
  line: number;
  modelAccesses: TAccess[];
  sourceFile?: string;
  owner?: string;
  inherited?: boolean;
}

export interface RailsActionOwner<TAccess> {
  name: string;
  qualifiedName?: string;
  filePath: string;
  parentName?: string;
  includedConcerns: string[];
  actions: RailsResolvedAction<TAccess>[];
}

export interface RailsActionConcern<TAccess> {
  name: string;
  filePath: string;
  includedConcerns: string[];
  actions: RailsResolvedAction<TAccess>[];
}

export function extractRailsConcernActions<TAccess>(
  content: string,
  filePath: string,
  extractAccesses: (body: string) => TAccess[],
): RailsActionConcern<TAccess> | undefined {
  const lines = content.split('\n');
  const declarationIndex = lines.findIndex(line => /^\s*module\s+[A-Z]\w*(?:::[A-Z]\w*)*/.test(line));
  if (declarationIndex < 0) return undefined;
  const declaration = /^(\s*)module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/.exec(lines[declarationIndex]);
  if (!declaration) return undefined;
  const actionIndent = declaration[1].length + 2;
  const actions: RailsResolvedAction<TAccess>[] = [];
  let visibility: 'public' | 'private' | 'protected' = 'public';

  for (let index = declarationIndex + 1; index < lines.length; index++) {
    const sourceLine = lines[index];
    const trimmed = sourceLine.trim();
    const indentation = sourceLine.match(/^\s*/)?.[0].length || 0;
    if (trimmed === 'end' && indentation <= declaration[1].length) break;
    if (indentation !== actionIndent) continue;
    if (/^(?:public|private|protected)$/.test(trimmed)) {
      visibility = trimmed as typeof visibility;
      continue;
    }
    const method = /^def\s+([a-zA-Z_]\w*[?!]?)/.exec(trimmed);
    if (!method || visibility !== 'public') continue;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      const nextTrimmed = next.trim();
      const nextIndentation = next.match(/^\s*/)?.[0].length || 0;
      if (nextTrimmed && nextIndentation <= actionIndent && (/^(?:def|public|private|protected)\b/.test(nextTrimmed) || nextTrimmed === 'end')) break;
      end += 1;
    }
    actions.push({
      name: method[1],
      line: index + 1,
      modelAccesses: extractAccesses(lines.slice(index, end).join('\n')),
      sourceFile: filePath,
      owner: declaration[2],
      inherited: true,
    });
  }

  return {
    name: declaration[2],
    filePath,
    includedConcerns: railsIncludedModules(content),
    actions,
  };
}

export function resolveRailsControllerActions<TAccess>(
  controllers: RailsActionOwner<TAccess>[],
  concerns: RailsActionConcern<TAccess>[],
): void {
  const controllersByName = new Map(controllers.flatMap(controller => [[controller.qualifiedName || controller.name, controller], [controller.name, controller]]));
  const concernsByName = new Map(concerns.flatMap(concern => [[concern.name, concern], [concern.name.split('::').pop() || concern.name, concern]]));
  const resolved = new Set<string>();
  const resolving = new Set<string>();
  const resolve = (controller: RailsActionOwner<TAccess>): void => {
    const key = controller.qualifiedName || controller.name;
    if (resolved.has(key) || resolving.has(key)) return;
    resolving.add(key);
    const parent = controller.parentName ? controllersByName.get(controller.parentName) || controllersByName.get(controller.parentName.split('::').pop() || controller.parentName) : undefined;
    if (parent) resolve(parent);
    const localNames = new Set(controller.actions.map(action => action.name));
    const inherited = [...controller.includedConcerns.flatMap(name => concernsByName.get(name)?.actions || []), ...(parent?.actions || [])];
    for (const action of inherited) if (!localNames.has(action.name)) {
      controller.actions.push({ ...action, inherited: true });
      localNames.add(action.name);
    }
    resolving.delete(key);
    resolved.add(key);
  };
  controllers.forEach(resolve);
}
