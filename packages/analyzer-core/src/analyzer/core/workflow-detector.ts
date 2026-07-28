import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASCallChain,
  CASWorkflow,
  CASWorkflowDependency,
  CASWorkflowGraph,
  CASDomainConcept
} from '../../types/cas.types';

interface WorkflowGroup {
  key: string;
  name: string;
  entryPoints: CASEntryPoint[];
  callChains: CASCallChain[];
  exitPoints: Set<string>;
  servicesUsed: Set<string>;
  entitiesReferenced: Set<string>;
  sharedServiceScore: number;
}

const INFRASTRUCTURE_KEYWORDS = new Set([
  'health', 'ping', 'ready', 'live', 'status',
  'metrics', 'telemetry', 'logging', 'log',
  'config', 'configuration', 'settings',
  'swagger', 'openapi', 'docs', 'documentation'
]);

const CROSS_CUTTING_KEYWORDS = new Set([
  'auth', 'authentication', 'authorization', 'login', 'logout', 'signin', 'signout',
  'session', 'token', 'jwt', 'oauth', 'sso',
  'permission', 'role', 'access', 'acl',
  'notification', 'email', 'mail', 'sms',
  'upload', 'download', 'file', 'storage', 'media',
  'cache', 'queue', 'job', 'worker', 'background'
]);

export class WorkflowDetector {
  private nodeIndex: Map<string, CASNode> = new Map();

  detectWorkflows(
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[],
    nodes: CASNode[],
    _edges: CASEdge[],
    _exitPoints: CASExitPoint[] = []
  ): CASWorkflow[] {
    this.nodeIndex = new Map(nodes.map(n => [n.id, n]));

    const groups = this.groupEntryPointsDynamically(entryPoints, callChains, nodes);

    const mergedGroups = this.mergeRelatedGroups(groups);

    const workflows: CASWorkflow[] = [];

    for (const [groupKey, group] of mergedGroups) {
      const workflow = this.createWorkflow(groupKey, group);
      if (workflow) {
        workflows.push(workflow);
      }
    }

    return workflows;
  }

  /**
   * True when the entry point's handler resolves into test or fixture
   * source rather than real product code. Mirrors (deliberately, not by
   * import — this detector has no dependency on AnalyzerOrchestrator)
   * isTestOrFixtureFileNode in core/orchestrator.ts: test-file naming
   * conventions plus fixtures/mocks directories, which the plain
   * `ep.type === 'test'` filter above does not catch (these entry points
   * carry a normal 'message'/'http'/'cli' type — only their SOURCE FILE
   * gives them away).
   */
  private isFixtureSourcedEntryPoint(ep: CASEntryPoint): boolean {
    const candidates = [ep.handler?.file, this.nodeIndex.get(ep.source_node)?.source?.file]
      .filter((f): f is string => Boolean(f));
    return candidates.some(file => {
      const normalized = file.replace(/\\/g, '/');
      const name = normalized.split('/').pop() || normalized;
      return /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name) ||
        /^test_.*\.py$/i.test(name) ||
        /_test\.(py|go|rs|dart)$/i.test(name) ||
        /(Test|Tests)\.(java|kt|cs|php)$/i.test(name) ||
        /(^|\/)(fixtures?|__fixtures__|mocks?|__mocks__|tests?)\//i.test(normalized);
    });
  }

  private isApplicationEntryPoint(ep: CASEntryPoint): boolean {
    const applicationTypes = new Set([
      'http', 'cli', 'websocket', 'ws_handler', 'message',
      'event', 'scheduled', 'cron', 'queue', 'grpc', 'graphql'
    ]);

    return applicationTypes.has(ep.type);
  }

  private groupEntryPointsDynamically(
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[],
    nodes: CASNode[]
  ): Map<string, WorkflowGroup> {
    const groups = new Map<string, WorkflowGroup>();
    const chainsByEntryPoint = this.indexChainsByEntryPoint(callChains);

    for (const ep of entryPoints) {
      if (ep.type === 'test') continue;
      if (!this.isApplicationEntryPoint(ep)) continue;
      // A registration literal captured from a test/fixture file (e.g. an MCP
      // tool-registration analyzer's OWN unit-test fixture string like
      // `server.registerTool('do_thing', ...)`, or a JSDoc example snippet in
      // real source) is analyzer scaffolding, not a real product surface —
      // promoting it to a named business workflow is exactly the junk-name
      // class in quality-iter-1 #8 ("Thing"/"Do Thing"/"Claw" with zero
      // entities/services touched, sourced entirely from
      // mcp-tool-registration-analyzer.test.ts / .integration.test.ts and a
      // comment-embedded example in the analyzer's own .ts source). Never
      // group these into a workflow at all.
      if (this.isFixtureSourcedEntryPoint(ep)) continue;

      const groupKey = this.extractGroupKey(ep);
      const chains = chainsByEntryPoint.get(ep.id) || [];

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          key: groupKey,
          name: this.formatGroupName(groupKey),
          entryPoints: [],
          callChains: [],
          exitPoints: new Set(),
          servicesUsed: new Set(),
          entitiesReferenced: new Set(),
          sharedServiceScore: 0
        });
      }

      const group = groups.get(groupKey)!;
      group.entryPoints.push(ep);
      group.callChains.push(...chains);

      for (const chain of chains) {
        if (chain.exit_point?.exit_point_id) {
          group.exitPoints.add(chain.exit_point.exit_point_id);
        }

        for (const step of chain.call_path) {
          const node = this.nodeIndex.get(step.node_id);
          if (this.isServiceNode(node)) {
            group.servicesUsed.add(step.node_id);
          }
          if (this.isEntityNode(node)) {
            group.entitiesReferenced.add(step.node_id);
          }
        }
      }
    }

    return groups;
  }

  private extractGroupKey(ep: CASEntryPoint): string {
    const path = ep.trigger?.path || '';
    const name = ep.name || '';
    const method = ep.trigger?.method?.toUpperCase() || '';

    if (path) {
      const segments = path.split('/').filter(s =>
        s && !s.startsWith(':') && !s.startsWith('{') && s !== 'api' && s !== 'v1' && s !== 'v2'
      );

      if (segments.length === 0) {
        return 'root';
      }

      const lastSegment = segments[segments.length - 1].toLowerCase();
      const isAction = this.isActionSegment(lastSegment);

      if (isAction && segments.length > 1) {
        const resource = this.findResourceSegment(segments.slice(0, -1));
        return `${resource}_${lastSegment}`;
      }

      const resource = this.findResourceSegment(segments);

      if (method === 'POST' && !['create', 'new', 'add'].some(a => path.includes(a))) {
        return `${resource}_create`;
      }
      if (method === 'DELETE') {
        return `${resource}_delete`;
      }
      if (method === 'PATCH' || method === 'PUT') {
        return `${resource}_update`;
      }

      return resource;
    }

    // Join ALL meaningful words, not just the first: for a pathless entry
    // point (mcp-tool/cli/event) `name` is usually a specific compound
    // identifier ("check_collision", "check_conceptual_conflicts") — taking
    // only words[0] discarded everything after the generic lead word and
    // collapsed distinct tools into one junk-named "Check" workflow
    // (quality-iter-1 #8: real, unrelated tools merged under a bare-noun
    // group with zero anchor evidence). Keeping the full compound also
    // converges with the path-based branch above for the SAME tool reached
    // through a second (e.g. AI-stack-detected) entry point whose trigger
    // carries a `path` — both now key on "check_collision" instead of
    // splitting into a specific group and a generic leftover.
    const words = this.extractMeaningfulWords(name);
    if (words.length > 0) {
      return words.map(w => w.toLowerCase()).join('_');
    }

    return 'misc';
  }

  private isActionSegment(segment: string): boolean {
    const actions = new Set([
      'analyze', 'process', 'sync', 'export', 'import', 'validate', 'verify',
      'activate', 'deactivate', 'enable', 'disable', 'approve', 'reject',
      'publish', 'unpublish', 'archive', 'restore', 'clone', 'duplicate',
      'login', 'logout', 'register', 'signup', 'signin', 'signout',
      'refresh', 'reset', 'confirm', 'cancel', 'submit', 'complete',
      'start', 'stop', 'pause', 'resume', 'retry', 'rollback',
      'upload', 'download', 'preview', 'render', 'generate', 'build',
      'connect', 'disconnect', 'subscribe', 'unsubscribe',
      'invite', 'join', 'leave', 'kick', 'ban', 'unban',
      'lock', 'unlock', 'freeze', 'unfreeze', 'pin', 'unpin'
    ]);
    return actions.has(segment);
  }

  private findResourceSegment(segments: string[]): string {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].toLowerCase();
      if (!this.isActionSegment(seg) && seg.length > 2) {
        return seg;
      }
    }
    return segments[0]?.toLowerCase() || 'misc';
  }

  private extractMeaningfulWords(name: string): string[] {
    const camelSplit = name.replace(/([a-z])([A-Z])/g, '$1 $2');

    const words = camelSplit.split(/[\s_\-\.]+/)
      .filter(w => w.length > 2)
      .filter(w => !['get', 'set', 'add', 'remove', 'update', 'delete', 'create', 'find', 'list', 'all'].includes(w.toLowerCase()));

    return words;
  }

  private formatGroupName(key: string): string {
    return key
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private isServiceNode(node: CASNode | undefined): boolean {
    if (!node) return false;
    return node.type === 'service' ||
           node.type === 'class' ||
           node.subcategories?.includes('service') ||
           node.name.toLowerCase().includes('service');
  }

  private isEntityNode(node: CASNode | undefined): boolean {
    if (!node) return false;
    return node.type === 'entity' ||
           node.type === 'model' ||
           node.subcategories?.includes('entity') === true;
  }

  private mergeRelatedGroups(groups: Map<string, WorkflowGroup>): Map<string, WorkflowGroup> {
    const groupList = Array.from(groups.values());

    const resourceGroups = new Map<string, WorkflowGroup[]>();
    const actionGroups: WorkflowGroup[] = [];

    for (const group of groupList) {
      const resource = this.extractResourceFromKey(group.key);
      const action = this.extractActionFromKey(group.key);

      if (action && this.isSignificantAction(action)) {
        actionGroups.push(group);
      } else {
        if (!resourceGroups.has(resource)) {
          resourceGroups.set(resource, []);
        }
        resourceGroups.get(resource)!.push(group);
      }
    }

    const merged = new Map<string, WorkflowGroup>();

    for (const [resource, resourceGroupList] of resourceGroups) {
      if (resourceGroupList.length === 1) {
        merged.set(resourceGroupList[0].key, resourceGroupList[0]);
      } else {
        const mergedGroup = this.mergeGroupSet(resourceGroupList);
        mergedGroup.key = resource;
        mergedGroup.name = this.formatGroupName(resource);
        merged.set(resource, mergedGroup);
      }
    }

    for (const actionGroup of actionGroups) {
      merged.set(actionGroup.key, actionGroup);
    }

    return merged;
  }

  private extractActionFromKey(key: string): string | null {
    const parts = key.split('_');
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      if (this.isActionSegment(lastPart)) {
        return lastPart;
      }
    }
    return null;
  }

  private isSignificantAction(action: string): boolean {
    const significantActions = new Set([
      'analyze', 'process', 'sync', 'export', 'import', 'validate',
      'publish', 'archive', 'restore', 'clone', 'duplicate',
      'login', 'logout', 'register', 'signup',
      'generate', 'build', 'deploy', 'migrate'
    ]);
    return significantActions.has(action);
  }

  private extractResourceFromKey(key: string): string {
    const parts = key.split('_');
    if (parts.length > 1) {
      const lastPart = parts[parts.length - 1];
      const crudActions = ['create', 'read', 'update', 'delete', 'list', 'get'];
      if (crudActions.includes(lastPart)) {
        return parts.slice(0, -1).join('_');
      }
    }
    return key;
  }

  private mergeGroupSet(groups: WorkflowGroup[]): WorkflowGroup {
    const primary = groups.reduce((best, current) =>
      current.entryPoints.length > best.entryPoints.length ? current : best
    );

    const merged: WorkflowGroup = {
      key: primary.key,
      name: primary.name,
      entryPoints: [],
      callChains: [],
      exitPoints: new Set(),
      servicesUsed: new Set(),
      entitiesReferenced: new Set(),
      sharedServiceScore: 0
    };

    for (const group of groups) {
      merged.entryPoints.push(...group.entryPoints);
      merged.callChains.push(...group.callChains);
      group.exitPoints.forEach(e => merged.exitPoints.add(e));
      group.servicesUsed.forEach(s => merged.servicesUsed.add(s));
      group.entitiesReferenced.forEach(e => merged.entitiesReferenced.add(e));
    }

    return merged;
  }

  private indexChainsByEntryPoint(callChains: CASCallChain[]): Map<string, CASCallChain[]> {
    const index = new Map<string, CASCallChain[]>();

    for (const chain of callChains) {
      const epId = chain.entry_point.entry_point_id;
      if (!epId) continue;

      if (!index.has(epId)) {
        index.set(epId, []);
      }
      index.get(epId)!.push(chain);
    }

    return index;
  }

  /**
   * Same purpose-bearing-anchor guard finalizeSystemCapabilityNames applies
   * to capabilities, adapted to workflows: a single-word group name with
   * NO anchor evidence — no entity/service touched by any of its call
   * chains, and no chain even reaches a real exit point — has nothing
   * grounding it as a genuine business workflow. This is a fallback net for
   * bare-noun groups that slip past the fixture/test-source exclusion above
   * (isFixtureSourcedEntryPoint) for whatever reason; it never fires on a
   * multi-word name (the join fix in extractGroupKey means those already
   * carry real specificity, e.g. "Check Collision").
   */
  private hasNoWorkflowAnchorEvidence(group: WorkflowGroup): boolean {
    return group.entitiesReferenced.size === 0 &&
      group.servicesUsed.size === 0 &&
      group.exitPoints.size === 0;
  }

  private isBareSingleWordGroupName(name: string): boolean {
    return name.trim().split(/\s+/).filter(Boolean).length === 1;
  }

  private createWorkflow(groupKey: string, group: WorkflowGroup): CASWorkflow | null {
    if (group.entryPoints.length === 0) return null;

    // Bare-noun / no-anchor-evidence guard: drop rather than ship a
    // purpose-less workflow (quality-iter-1 #8). No "parent operation" name
    // to fall back to exists at this point (the group's own entry points ARE
    // the parent operations, and none of them grounds a purpose) — the
    // honest outcome is not emitting, not guessing a name.
    if (this.isBareSingleWordGroupName(group.name) && this.hasNoWorkflowAnchorEvidence(group)) {
      return null;
    }

    const workflowType = this.inferWorkflowType(group);
    const criticality = this.computeWorkflowCriticality(group);

    return {
      id: `workflow_${groupKey}`,
      name: group.name,
      description: this.generateWorkflowDescription(group, workflowType),
      workflow_type: workflowType,

      entry_points: group.entryPoints.map(ep => ep.id),
      call_chains: group.callChains.map(c => c.id),
      exit_points: Array.from(group.exitPoints),

      entities_touched: Array.from(group.entitiesReferenced),
      services_used: Array.from(group.servicesUsed),

      classification: 'supporting',
      criticality,

      dependencies: [],
      dependents: []
    };
  }

  private inferWorkflowType(group: WorkflowGroup): 'crud' | 'process' | 'query' | 'command' | 'composite' {
    const methods = new Set(group.entryPoints.map(ep => ep.trigger?.method?.toUpperCase()).filter(Boolean));

    const hasGet = methods.has('GET');
    const hasPost = methods.has('POST');
    const hasPut = methods.has('PUT');
    const hasDelete = methods.has('DELETE');
    const hasPatch = methods.has('PATCH');

    const crudOperations = [hasPost, hasGet, hasPut || hasPatch, hasDelete].filter(Boolean).length;

    if (crudOperations >= 3) return 'crud';
    if (hasGet && !hasPost && !hasPut && !hasDelete && !hasPatch) return 'query';
    if ((hasPost || hasPut || hasPatch) && !hasGet) return 'command';

    const avgChainLength = group.callChains.length > 0
      ? group.callChains.reduce((sum, c) => sum + c.call_path.length, 0) / group.callChains.length
      : 0;

    if (avgChainLength > 5) return 'process';
    if (methods.size > 3) return 'composite';

    return 'command';
  }

  private computeWorkflowCriticality(group: WorkflowGroup): 'critical' | 'high' | 'medium' | 'low' {
    const hasAuth = group.entryPoints.some(ep => ep.security?.authenticated);
    const hasMutations = group.entryPoints.some(ep => {
      const method = ep.trigger?.method?.toUpperCase();
      return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    });

    const hasDbOperations = group.callChains.some(c => c.characteristics?.has_database_calls);
    const hasExternalCalls = group.callChains.some(c => c.characteristics?.has_external_calls);

    if (hasAuth && hasMutations && (hasDbOperations || hasExternalCalls)) {
      return 'critical';
    }

    if ((hasAuth && hasMutations) || (hasMutations && hasDbOperations)) {
      return 'high';
    }

    if (hasMutations || hasDbOperations || hasExternalCalls) {
      return 'medium';
    }

    return 'low';
  }

  private generateWorkflowDescription(group: WorkflowGroup, _workflowType: string): string {
    const entryCount = group.entryPoints.length;
    const methods = new Set(group.entryPoints.map(ep => ep.trigger?.method).filter(Boolean));
    const methodList = Array.from(methods).join(', ');

    const serviceCount = group.servicesUsed.size;
    const entityCount = group.entitiesReferenced.size;

    let desc = `${group.name} with ${entryCount} endpoint(s)`;

    if (methodList) {
      desc += ` supporting ${methodList} operations`;
    }

    if (serviceCount > 0 || entityCount > 0) {
      const parts: string[] = [];
      if (serviceCount > 0) parts.push(`${serviceCount} service(s)`);
      if (entityCount > 0) parts.push(`${entityCount} entity(ies)`);
      desc += `, using ${parts.join(' and ')}`;
    }

    return desc;
  }

  classifyWorkflows(workflows: CASWorkflow[], domainConcepts: CASDomainConcept[]): void {
    const coreConcepts = new Set(
      domainConcepts
        .filter(c => c.classification === 'core')
        .map(c => c.name.toLowerCase())
    );

    const conceptFrequency = new Map<string, number>();
    for (const c of domainConcepts) {
      conceptFrequency.set(c.name.toLowerCase(), c.frequency);
    }

    for (const workflow of workflows) {
      workflow.classification = this.classifyWorkflow(workflow, coreConcepts, conceptFrequency);
    }
  }

  private classifyWorkflow(
    workflow: CASWorkflow,
    coreConcepts: Set<string>,
    conceptFrequency: Map<string, number>
  ): 'primary' | 'supporting' | 'internal' {
    const workflowName = workflow.name.toLowerCase();
    const workflowKey = workflow.id.replace('workflow_', '').toLowerCase();

    const nameWords = workflowName.split(/\s+/);
    const keyWords = workflowKey.split(/[-_]/);
    const allWords = new Set([...nameWords, ...keyWords]);

    if ([...allWords].some(w => INFRASTRUCTURE_KEYWORDS.has(w))) {
      return 'internal';
    }

    if ([...allWords].some(w => CROSS_CUTTING_KEYWORDS.has(w))) {
      return 'supporting';
    }

    const matchesCore = [...allWords].some(w => coreConcepts.has(w));

    if (matchesCore) {
      return 'primary';
    }

    let maxFreq = 0;
    for (const word of allWords) {
      const freq = conceptFrequency.get(word) || 0;
      if (freq > maxFreq) maxFreq = freq;
    }

    if (maxFreq > 5 && workflow.entry_points.length > 2) {
      return 'primary';
    }

    if (workflow.entry_points.length === 0) {
      return 'internal';
    }

    return 'supporting';
  }

  buildDependencyGraph(
    workflows: CASWorkflow[],
    _callChains: CASCallChain[],
    _nodes: CASNode[]
  ): CASWorkflowGraph {
    const dependencies: CASWorkflowDependency[] = [];

    const workflowByService = this.indexWorkflowsByServices(workflows);
    const workflowByEntity = this.indexWorkflowsByEntities(workflows);

    for (const workflow of workflows) {
      this.detectServiceDependencies(workflow, workflowByService, dependencies);
      this.detectEntityDependencies(workflow, workflowByEntity, dependencies);
      this.detectAuthDependencies(workflow, workflows, dependencies);
    }

    for (const dep of dependencies) {
      const fromWorkflow = workflows.find(w => w.id === dep.from_workflow);
      const toWorkflow = workflows.find(w => w.id === dep.to_workflow);

      if (fromWorkflow && !fromWorkflow.dependencies.includes(dep.to_workflow)) {
        fromWorkflow.dependencies.push(dep.to_workflow);
      }
      if (toWorkflow && !toWorkflow.dependents.includes(dep.from_workflow)) {
        toWorkflow.dependents.push(dep.from_workflow);
      }
    }

    const primaryWorkflow = this.findPrimaryWorkflow(workflows, dependencies);
    const entryWorkflow = this.findEntryWorkflow(workflows);
    const criticalSharedNodes = this.findCriticalSharedNodes(workflows);

    return {
      workflows,
      dependencies,
      primary_workflow_id: primaryWorkflow?.id,
      entry_workflow_id: entryWorkflow?.id,
      critical_shared_nodes: criticalSharedNodes
    };
  }

  private indexWorkflowsByServices(workflows: CASWorkflow[]): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const workflow of workflows) {
      for (const serviceId of workflow.services_used) {
        if (!index.has(serviceId)) {
          index.set(serviceId, []);
        }
        index.get(serviceId)!.push(workflow.id);
      }
    }

    return index;
  }

  private indexWorkflowsByEntities(workflows: CASWorkflow[]): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const workflow of workflows) {
      for (const entityId of workflow.entities_touched) {
        if (!index.has(entityId)) {
          index.set(entityId, []);
        }
        index.get(entityId)!.push(workflow.id);
      }
    }

    return index;
  }

  private detectServiceDependencies(
    workflow: CASWorkflow,
    workflowByService: Map<string, string[]>,
    dependencies: CASWorkflowDependency[]
  ): void {
    for (const serviceId of workflow.services_used) {
      const otherWorkflows = workflowByService.get(serviceId) || [];

      for (const otherWorkflowId of otherWorkflows) {
        if (otherWorkflowId === workflow.id) continue;

        const existing = dependencies.find(d =>
          d.from_workflow === workflow.id && d.to_workflow === otherWorkflowId
        );

        if (!existing) {
          const node = this.nodeIndex.get(serviceId);
          dependencies.push({
            from_workflow: workflow.id,
            to_workflow: otherWorkflowId,
            dependency_type: 'calls',
            strength: 'optional',
            evidence: [`Both workflows use ${node?.name || serviceId}`]
          });
        }
      }
    }
  }

  private detectEntityDependencies(
    workflow: CASWorkflow,
    workflowByEntity: Map<string, string[]>,
    dependencies: CASWorkflowDependency[]
  ): void {
    for (const entityId of workflow.entities_touched) {
      const otherWorkflows = workflowByEntity.get(entityId) || [];

      for (const otherWorkflowId of otherWorkflows) {
        if (otherWorkflowId === workflow.id) continue;

        const existing = dependencies.find(d =>
          d.from_workflow === workflow.id &&
          d.to_workflow === otherWorkflowId &&
          d.dependency_type === 'reads-from'
        );

        if (!existing) {
          const node = this.nodeIndex.get(entityId);
          dependencies.push({
            from_workflow: workflow.id,
            to_workflow: otherWorkflowId,
            dependency_type: 'reads-from',
            strength: 'optional',
            evidence: [`Both workflows reference ${node?.name || entityId}`]
          });
        }
      }
    }
  }

  private detectAuthDependencies(
    workflow: CASWorkflow,
    allWorkflows: CASWorkflow[],
    dependencies: CASWorkflowDependency[]
  ): void {
    const authWorkflow = allWorkflows.find(w =>
      w.classification === 'supporting' &&
      (w.name.toLowerCase().includes('auth') || w.id.includes('auth'))
    );

    if (!authWorkflow || workflow.id === authWorkflow.id) return;

    const existing = dependencies.find(d =>
      d.from_workflow === workflow.id && d.to_workflow === authWorkflow.id
    );

    if (!existing) {
      dependencies.push({
        from_workflow: workflow.id,
        to_workflow: authWorkflow.id,
        dependency_type: 'requires-auth',
        strength: 'required',
        evidence: [`${workflow.name} endpoints may require authentication`]
      });
    }
  }

  private findPrimaryWorkflow(
    workflows: CASWorkflow[],
    dependencies: CASWorkflowDependency[]
  ): CASWorkflow | undefined {
    const primary = workflows.filter(w => w.classification === 'primary');

    if (primary.length === 1) {
      return primary[0];
    }

    if (primary.length > 1) {
      return primary.reduce((best, current) => {
        const bestScore = this.computeWorkflowImportanceScore(best, dependencies);
        const currentScore = this.computeWorkflowImportanceScore(current, dependencies);
        return currentScore > bestScore ? current : best;
      });
    }

    const supporting = workflows.filter(w => w.classification === 'supporting');
    if (supporting.length > 0) {
      return supporting.reduce((best, current) => {
        const bestScore = this.computeWorkflowImportanceScore(best, dependencies);
        const currentScore = this.computeWorkflowImportanceScore(current, dependencies);
        return currentScore > bestScore ? current : best;
      });
    }

    return workflows[0];
  }

  private computeWorkflowImportanceScore(
    workflow: CASWorkflow,
    dependencies: CASWorkflowDependency[]
  ): number {
    const entryPointCount = workflow.entry_points.length;
    const dependentCount = dependencies.filter(d => d.to_workflow === workflow.id).length;
    const serviceCount = workflow.services_used.length;
    const entityCount = workflow.entities_touched.length;

    return (entryPointCount * 3) + (dependentCount * 5) + serviceCount + entityCount;
  }

  private findEntryWorkflow(workflows: CASWorkflow[]): CASWorkflow | undefined {
    const auth = workflows.find(w =>
      w.name.toLowerCase().includes('auth') || w.id.includes('auth')
    );

    if (auth) return auth;

    return workflows.find(w => w.dependencies.length === 0);
  }

  private findCriticalSharedNodes(
    workflows: CASWorkflow[]
  ): Array<{ node_id: string; used_by_workflows: string[]; criticality: 'critical' | 'high' | 'medium' | 'low' }> {
    const nodeUsage = new Map<string, string[]>();

    for (const workflow of workflows) {
      for (const serviceId of workflow.services_used) {
        if (!nodeUsage.has(serviceId)) {
          nodeUsage.set(serviceId, []);
        }
        nodeUsage.get(serviceId)!.push(workflow.id);
      }
    }

    const sharedNodes: Array<{ node_id: string; used_by_workflows: string[]; criticality: 'critical' | 'high' | 'medium' | 'low' }> = [];

    for (const [nodeId, workflowIds] of nodeUsage) {
      if (workflowIds.length >= 2) {
        const criticality = workflowIds.length >= 4 ? 'critical' :
                           workflowIds.length >= 3 ? 'high' :
                           'medium';

        sharedNodes.push({
          node_id: nodeId,
          used_by_workflows: workflowIds,
          criticality
        });
      }
    }

    return sharedNodes.sort((a, b) => b.used_by_workflows.length - a.used_by_workflows.length);
  }
}
