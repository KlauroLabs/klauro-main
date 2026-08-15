import type { CASNode, CASEdge, CASEntryPoint, CASDataEntity, CASDecorator } from '../../types/cas.types';

























export type ConventionRouteConvention =
  | {
      kind?: 'decorator';
      decorator: string;
      path_arg?: number | string;
      method_arg?: number | string;
      default_method?: string;
    }
  | {
      kind: 'call';
      call: string;
      method_arg: number | string;
      path_arg: number | string;
      handler_arg: number | string;
    };

export interface ConventionEntryPointConvention {
  files: string;
  export_matches: string;
  kind: CASEntryPoint['type'];
}

export interface ConventionEntityConvention {
  name_suffix?: string;
  name_regex?: string;
  decorator?: string;
}

export interface ConventionDiBindingConvention {
  call: string;
  token_arg: number | string;
  impl_arg: number | string;
}

export interface ConventionRoleConvention {
  name_suffix?: string;
  name_regex?: string;
  role: string;
}

export interface ConventionFlowConvention {
  name: string;
  steps: string[];
}

export interface KlauroConventionsInput {
  routes?: ConventionRouteConvention[];
  entry_points?: ConventionEntryPointConvention[];
  entities?: ConventionEntityConvention[];
  di_bindings?: ConventionDiBindingConvention[];
  roles?: ConventionRoleConvention[];
  flows?: ConventionFlowConvention[];
}

export interface ConventionsApplyResult {
  entry_points: CASEntryPoint[];
  entities: CASDataEntity[];
  edges: CASEdge[];

  role_tags: Array<{ node_id: string; role: string }>;

  matches: ConventionMatchReport[];
}

export interface ConventionMatchReport {
  convention_kind: 'route' | 'entry_point' | 'entity' | 'di_binding' | 'role' | 'flow';
  convention_summary: string;
  matched_node_ids: string[];
  matched: boolean;
  reason?: string;
}

function toRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}


function globToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const next = glob[i + 1];
    const afterNext = glob[i + 2];



    if (c === '*' && next === '*' && afterNext === '/') { out += '(?:.*/)?'; i += 2; }
    else if (c === '*' && next === '*') { out += '.*'; i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '.';
    else if ('\\^$+.()|[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

function fileMatchesGlob(file: string | undefined, glob: string): boolean {
  if (!file) return false;
  const normalized = file.replace(/\\/g, '/').replace(/^\/+/, '');
  return globToRegex(glob).test(normalized) || globToRegex(glob).test(normalized.split('/').pop() || '');
}

function isFunctionLike(node: CASNode): boolean {
  return node.type === 'function' || node.type === 'method';
}

function isClassLike(node: CASNode): boolean {
  return node.type === 'class' || node.type === 'service' || node.type === 'controller' || node.type === 'component';
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_declared_${seq}`;
}







export function applyConventions(
  conventions: KlauroConventionsInput | undefined,
  nodes: CASNode[],
  edges: CASEdge[],
  decorators: CASDecorator[] = [],
): ConventionsApplyResult {





  seq = 0;
  const result: ConventionsApplyResult = {
    entry_points: [],
    entities: [],
    edges: [],
    role_tags: [],
    matches: [],
  };
  if (!conventions) return result;

  applyRouteConventions(conventions.routes, nodes, decorators, result);
  applyEntryPointConventions(conventions.entry_points, nodes, result);
  applyEntityConventions(conventions.entities, nodes, result);
  applyDiBindingConventions(conventions.di_bindings, nodes, edges, result);
  applyRoleConventions(conventions.roles, nodes, result);
  applyFlowConventions(conventions.flows, nodes, result);

  return result;
}








function nodeDecoratorNames(node: CASNode): string[] {
  const attrs = node.metadata?.attributes as any;
  const raw = attrs?.decorators;
  if (!Array.isArray(raw)) return [];
  return raw.map((d: any) => (typeof d === 'string' ? d : d?.name)).filter(Boolean);
}








function decoratorsForNode(node: CASNode, decorators: CASDecorator[], decoratorName: string): CASDecorator[] {
  return decorators.filter(d => d.target_node === node.id && d.decorator_info.name === decoratorName);
}

function applyRouteConventions(
  routeConventions: ConventionRouteConvention[] | undefined,
  nodes: CASNode[],
  decorators: CASDecorator[],
  result: ConventionsApplyResult,
): void {
  for (const route of routeConventions || []) {
    const isCallRoute = 'call' in route && route.kind === 'call';
    if ('decorator' in route && !isCallRoute) {
      const decoratorName = route.decorator.replace(/^@/, '');
      const summary = `decorator route: ${route.decorator}`;
      const candidates = nodes.filter(n => isFunctionLike(n) && nodeDecoratorNames(n).some(name => name === decoratorName));
      if (candidates.length === 0) {
        result.matches.push({ convention_kind: 'route', convention_summary: summary, matched_node_ids: [], matched: false, reason: `No function/method node carries decorator "${route.decorator}"` });
        continue;
      }
      const matchedIds: string[] = [];
      const argsUnresolved: string[] = [];
      for (const node of candidates) {
        const decoratorEvidence = decoratorsForNode(node, decorators, decoratorName);
        const args = decoratorEvidence.flatMap(d => d.parameters || []);
        const path = pickDecoratorArg(args, route.path_arg);
        const method = (pickDecoratorArg(args, route.method_arg) || route.default_method || 'GET').toString().toUpperCase();
        if (!path) {
          argsUnresolved.push(node.id);
          continue;
        }
        result.entry_points.push(buildHttpEntryPoint(node, method, path.toString(), 'declared-route-decorator'));
        matchedIds.push(node.id);
      }
      result.matches.push({
        convention_kind: 'route',
        convention_summary: summary,
        matched_node_ids: [...matchedIds, ...argsUnresolved],
        matched: matchedIds.length > 0,
        reason: matchedIds.length === 0
          ? `Decorator "${route.decorator}" found on ${candidates.length} node(s), but no argument capture is available for this decorator shape (only recognized-framework decorators resolve arguments) — no route emitted rather than fabricating path/method.`
          : (argsUnresolved.length > 0 ? `${argsUnresolved.length} additional node(s) carried the decorator but had no resolvable arguments` : undefined),
      });
    } else if ('kind' in route && route.kind === 'call') {
      const summary = `call-based route: ${route.call}`;
      const callTargetShort = route.call.split('.').pop() || route.call;
      const candidates = nodes.filter(n => isFunctionLike(n) && (n.implementation?.uses || []).some(u => u === route.call || u.endsWith(`.${callTargetShort}`)));
      if (candidates.length === 0) {
        result.matches.push({ convention_kind: 'route', convention_summary: summary, matched_node_ids: [], matched: false, reason: `No function/method node calls "${route.call}"` });
        continue;
      }



      result.matches.push({
        convention_kind: 'route',
        convention_summary: summary,
        matched_node_ids: candidates.map(n => n.id),
        matched: false,
        reason: `Call site(s) to "${route.call}" found in ${candidates.length} node(s), but argument extraction requires source.raw on the call node — no route emitted (evidence insufficient to avoid fabricating path/method).`,
      });
    }
  }
}

function pickDecoratorArg(
  args: Array<{ name: string; value: any; type: string }>,
  selector: number | string | undefined,
): string | undefined {
  if (selector === undefined || args.length === 0) return undefined;






  if (typeof selector === 'number') {
    const byIndex = args.find(a => a.name === String(selector));
    return byIndex && byIndex.value !== undefined ? String(byIndex.value) : undefined;
  }
  const byName = args.find(a => a.name === selector);
  return byName ? String(byName.value) : undefined;
}

function buildHttpEntryPoint(node: CASNode, method: string, routePath: string, sourceAnalyzer: string): CASEntryPoint {
  return {
    id: nextId('entry_point'),
    source_node: node.id,
    source_analyzer: sourceAnalyzer,
    type: 'http',
    name: `${method} ${routePath}`,
    description: `Declared custom route (${sourceAnalyzer}) resolved to ${node.qualified_name || node.name}`,
    description_source: 'deterministic',
    trigger: { method, path: routePath },
    handler: { node_id: node.id, method_name: node.name, file: node.source?.file, line: node.source?.line },
    metadata: { declared: true, handler: node.name },
  };
}

function applyEntryPointConventions(
  epConventions: ConventionEntryPointConvention[] | undefined,
  nodes: CASNode[],
  result: ConventionsApplyResult,
): void {
  for (const ep of epConventions || []) {
    const summary = `entry_point: files=${ep.files} export_matches=${ep.export_matches} kind=${ep.kind}`;
    const regex = toRegex(ep.export_matches);
    if (!regex) {
      result.matches.push({ convention_kind: 'entry_point', convention_summary: summary, matched_node_ids: [], matched: false, reason: `Invalid export_matches regex: "${ep.export_matches}"` });
      continue;
    }
    const candidates = nodes.filter(n =>
      fileMatchesGlob(n.source?.file, ep.files) &&
      (n.metadata?.is_exported === true || isFunctionLike(n) || isClassLike(n)) &&
      regex.test(n.name)
    );
    if (candidates.length === 0) {
      result.matches.push({ convention_kind: 'entry_point', convention_summary: summary, matched_node_ids: [], matched: false, reason: `No exported node in files matching "${ep.files}" has a name matching /${ep.export_matches}/` });
      continue;
    }
    const matchedIds: string[] = [];
    for (const node of candidates) {
      result.entry_points.push({
        id: nextId('entry_point'),
        source_node: node.id,
        source_analyzer: 'declared-entry-point-convention',
        type: ep.kind,
        name: node.name,
        description: `Declared custom entry point (${ep.kind}) matching export_matches "${ep.export_matches}" in ${ep.files}`,
        description_source: 'deterministic',
        handler: { node_id: node.id, method_name: node.name, file: node.source?.file, line: node.source?.line },
        metadata: { declared: true },
      });
      matchedIds.push(node.id);
    }
    result.matches.push({ convention_kind: 'entry_point', convention_summary: summary, matched_node_ids: matchedIds, matched: true });
  }
}

function applyEntityConventions(
  entityConventions: ConventionEntityConvention[] | undefined,
  nodes: CASNode[],
  result: ConventionsApplyResult,
): void {
  for (const entity of entityConventions || []) {
    const parts: string[] = [];
    if (entity.name_suffix) parts.push(`name_suffix=${entity.name_suffix}`);
    if (entity.name_regex) parts.push(`name_regex=${entity.name_regex}`);
    if (entity.decorator) parts.push(`decorator=${entity.decorator}`);
    const summary = `entity: ${parts.join(' ')}`;

    const nameRegex = entity.name_regex ? toRegex(entity.name_regex) : undefined;
    if (entity.name_regex && !nameRegex) {
      result.matches.push({ convention_kind: 'entity', convention_summary: summary, matched_node_ids: [], matched: false, reason: `Invalid name_regex: "${entity.name_regex}"` });
      continue;
    }
    const decoratorName = entity.decorator?.replace(/^@/, '');

    const candidates = nodes.filter(n => {
      if (!isClassLike(n)) return false;
      if (entity.name_suffix && !n.name.endsWith(entity.name_suffix)) return false;
      if (nameRegex && !nameRegex.test(n.name)) return false;
      if (decoratorName && !nodeDecoratorNames(n).some(name => name === decoratorName)) return false;
      return true;
    });

    if (candidates.length === 0) {
      result.matches.push({ convention_kind: 'entity', convention_summary: summary, matched_node_ids: [], matched: false, reason: 'No class-like node matched the declared name/decorator pattern' });
      continue;
    }

    const matchedIds: string[] = [];
    for (const node of candidates) {
      result.entities.push({
        id: nextId('data_entity'),
        name: node.name,
        schema_source: node.source?.file,
        description: `Declared custom entity convention match (${summary})`,
        description_source: 'deterministic',
        lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
      } as CASDataEntity);
      matchedIds.push(node.id);
    }
    result.matches.push({ convention_kind: 'entity', convention_summary: summary, matched_node_ids: matchedIds, matched: true });
  }
}

function applyDiBindingConventions(
  bindingConventions: ConventionDiBindingConvention[] | undefined,
  nodes: CASNode[],
  edges: CASEdge[],
  result: ConventionsApplyResult,
): void {
  for (const binding of bindingConventions || []) {
    const summary = `di_binding: ${binding.call}`;
    const callTargetShort = binding.call.split('.').pop() || binding.call;
    const candidates = nodes.filter(n => (n.implementation?.uses || []).some(u => u === binding.call || u.endsWith(`.${callTargetShort}`)));
    if (candidates.length === 0) {
      result.matches.push({ convention_kind: 'di_binding', convention_summary: summary, matched_node_ids: [], matched: false, reason: `No node calls "${binding.call}"` });
      continue;
    }



    result.matches.push({
      convention_kind: 'di_binding',
      convention_summary: summary,
      matched_node_ids: candidates.map(n => n.id),
      matched: false,
      reason: `Call site(s) to "${binding.call}" found, but token_arg/impl_arg resolution requires call-site argument capture not currently available — no binding edge emitted.`,
    });
  }
}

function applyRoleConventions(
  roleConventions: ConventionRoleConvention[] | undefined,
  nodes: CASNode[],
  result: ConventionsApplyResult,
): void {
  for (const role of roleConventions || []) {
    const parts: string[] = [];
    if (role.name_suffix) parts.push(`name_suffix=${role.name_suffix}`);
    if (role.name_regex) parts.push(`name_regex=${role.name_regex}`);
    const summary = `role: ${parts.join(' ')} -> ${role.role}`;

    const nameRegex = role.name_regex ? toRegex(role.name_regex) : undefined;
    if (role.name_regex && !nameRegex) {
      result.matches.push({ convention_kind: 'role', convention_summary: summary, matched_node_ids: [], matched: false, reason: `Invalid name_regex: "${role.name_regex}"` });
      continue;
    }
    const candidates = nodes.filter(n => {
      if (role.name_suffix && !n.name.endsWith(role.name_suffix)) return false;
      if (nameRegex && !nameRegex.test(n.name)) return false;
      return role.name_suffix || nameRegex;
    });
    if (candidates.length === 0) {
      result.matches.push({ convention_kind: 'role', convention_summary: summary, matched_node_ids: [], matched: false, reason: 'No node name matched the declared suffix/regex' });
      continue;
    }
    for (const node of candidates) {
      result.role_tags.push({ node_id: node.id, role: role.role });
    }
    result.matches.push({ convention_kind: 'role', convention_summary: summary, matched_node_ids: candidates.map(n => n.id), matched: true });
  }
}

function applyFlowConventions(
  flowConventions: ConventionFlowConvention[] | undefined,
  nodes: CASNode[],
  result: ConventionsApplyResult,
): void {
  for (const flow of flowConventions || []) {
    const summary = `flow: ${flow.name} (${flow.steps.join(' -> ')})`;
    const firstStep = flow.steps[0];
    const stepNode = resolveStepReference(firstStep, nodes);
    if (!stepNode) {
      result.matches.push({ convention_kind: 'flow', convention_summary: summary, matched_node_ids: [], matched: false, reason: `Could not resolve first declared step "${firstStep}" to a real function/method node` });
      continue;
    }




    const resolvedSteps = flow.steps.map(step => ({ step, node: resolveStepReference(step, nodes) }));
    const unresolved = resolvedSteps.filter(s => !s.node).map(s => s.step);







    result.entry_points.push({
      id: nextId('entry_point'),
      source_node: stepNode.id,
      source_analyzer: 'declared-flow-convention',
      type: 'api',
      name: flow.name,
      description: `Declared custom flow "${flow.name}": ${flow.steps.join(' -> ')}`,
      description_source: 'deterministic',
      handler: { node_id: stepNode.id, method_name: stepNode.name, file: stepNode.source?.file, line: stepNode.source?.line },
      metadata: { declared: true, declared_flow_name: flow.name, declared_steps: flow.steps },
    });

    result.matches.push({
      convention_kind: 'flow',
      convention_summary: summary,
      matched_node_ids: resolvedSteps.filter(s => s.node).map(s => s.node!.id),
      matched: true,
      reason: unresolved.length > 0 ? `Step(s) not resolved to a real node (flow still rooted at "${firstStep}"): ${unresolved.join(', ')}` : undefined,
    });
  }
}


function resolveStepReference(ref: string, nodes: CASNode[]): CASNode | undefined {
  const [maybeClass, maybeMethod] = ref.includes('.') ? ref.split('.') : [undefined, ref];
  if (maybeClass && maybeMethod) {
    return nodes.find(n =>
      isFunctionLike(n) &&
      n.name === maybeMethod &&
      (n.qualified_name?.includes(maybeClass) || n.parent === nodes.find(p => isClassLike(p) && p.name === maybeClass)?.id)
    );
  }
  return nodes.find(n => isFunctionLike(n) && n.name === maybeMethod);
}
