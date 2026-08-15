import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASEntryPoint, CASContribution, CASExitPoint, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type WorkflowSystem = 'temporal' | 'celery' | 'sidekiq' | 'bullmq' | 'kafka' | 'rabbitmq' | 'nats' | 'step-functions' | 'durable-functions' | 'camunda-zeebe' | 'cadence';















export class WorkflowAnalyzer extends BaseAnalyzer {
  constructor() {
    super('workflow', 'Workflow Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const deps = await this.collectDependencyNames(projectPath);
    const depMarkers = [
      '@temporalio/client',
      '@temporalio/worker',
      '@temporalio/workflow',
      '@temporalio/activity',
      'temporalio',
      'celery',
      'sidekiq',
      'bullmq',
      'bull',
      'kafkajs',
      'amqplib',
      'nats',
      'kafka-python',
      'confluent-kafka',
    ];
    if (depMarkers.some((m) => deps.has(m))) {
      return true;
    }



    const ignorePatterns = this.getIgnorePatterns({ projectPath });
    const files = await glob('**/*.{ts,js,py,rb,go,rs,java,cs}', {
      cwd: projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });

    const sample = files.slice(0, 400);
    const importRe =
      /(@temporalio|temporalio|celery|sidekiq|bullmq|require\s*\(\s*['"]bull['"]\)|from\s+['"]bull['"]|kafkajs|Sidekiq::(Job|Worker)|@shared_task|@app\.task|segmentio\/kafka-go|kafka\.NewWriter|kafka\.NewReader|nats-io\/nats|rdkafka|FutureRecord|async[_-]nats|KafkaTemplate|@KafkaListener|Confluent\.Kafka|durable-functions|df\.orchestrator|zeebe|ZBClient|go\.uber\.org\/cadence|go\.temporal\.io)/;
    for (const file of sample) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        if (importRe.test(content)) return true;
      } catch {

      }
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    this.resetAnalysisWarnings();

    const ignorePatterns = this.getIgnorePatterns(context);
    let files = await glob('**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,go,rs,java,cs}', {
      cwd: context.projectPath,
      ignore: ignorePatterns,
      absolute: true,
      nodir: true,
    });
    files = this.capAndPrioritizeSourceFiles(files, 'workflow source files');


    try {
      const aslFiles = await glob('**/*.asl.json', {
        cwd: context.projectPath,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
      });
      files = [...files, ...aslFiles];
    } catch {

    }

    const { nodes, edges, entryPoints } = await this.processFiles(files, context.projectPath);

    const systemsFound = new Set<string>();
    for (const n of nodes) {
      const sys = (n.metadata as any)?.system;
      if (sys) systemsFound.add(sys);
    }

    return this.createContribution(nodes, edges, entryPoints, [], {
      systems: Array.from(systemsFound),
      flowsFound: entryPoints.length,
      nodesFound: nodes.length,
      edgesFound: edges.length,
      warnings: this.collectAnalysisWarnings(),
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let files: string[] = [];
    try {
      files = await glob(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rb,go,rs,java,cs}', '**/*.asl.json'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true,
      });
    } catch {
      return [];
    }

    const markerRe =
      /(@temporalio|temporalio|proxyActivities|@workflow\.defn|@activity\.defn|celery|@shared_task|@app\.task|\.delay\s*\(|\.apply_async\s*\(|Sidekiq::(?:Job|Worker)|\.perform_async|new\s+Queue\b|new\s+Worker\b|\.subscribe\s*\(|kafkajs|\bbullmq\b|\bbull\b|amqplib|\.sendToQueue\s*\(|\.consume\s*\(|\bnats\b|KafkaProducer|KafkaConsumer|kafka-python|confluent_kafka|kafka\.NewWriter|kafka\.NewReader|\.Publish\s*\(|\.Subscribe\s*\(|rdkafka|FutureRecord|async[_-]nats|KafkaTemplate|@KafkaListener|Confluent\.Kafka|"StartAt"|df\.orchestrator|callActivity|createWorker|ZBClient|workflow\.ExecuteActivity|execute_activity|go\.uber\.org\/cadence|go\.temporal\.io)/;
    const relevant: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (markerRe.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);



    const { nodes, edges, entryPoints } = await this.processFiles(
      [context.filePath],
      context.projectPath
    );

    const exitPoints: CASExitPoint[] = [];
    const exports = entryPoints.map(ep => ep.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }






  private async processFiles(
    files: string[],
    projectPath: string
  ): Promise<{ nodes: CASNode[]; edges: CASEdge[]; entryPoints: CASEntryPoint[] }> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];


    const queueNodeIds = new Map<string, string>();
    const jobNodeIds = new Map<string, string>();
    const pendingEnqueues: Array<{ system: WorkflowSystem; jobName: string; filePath: string; line: number }> = [];
    const pendingQueueAdds: Array<{ queueName: string; jobName: string; filePath: string; line: number }> = [];

    const ensureQueueNode = (system: WorkflowSystem, name: string, filePath: string, line?: number): string => {
      const key = `${system}:${name}`;
      const existing = queueNodeIds.get(key);
      if (existing) return existing;
      const id = `flow_${system}_queue_${this.sanitizeId(name)}`;
      queueNodeIds.set(key, id);
      nodes.push(
        this.createNode(id, name, system === 'kafka' ? 'topic' : 'queue', 3, filePath, line, undefined, {
          system,
          kind: system === 'kafka' ? 'topic' : 'queue',
          subcategories: ['async-flow', system],
        })
      );
      return id;
    };

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const relativePath = path.relative(projectPath, file);
      const ext = path.extname(file).toLowerCase();
      const lines = content.split('\n');
      const lineOf = (index: number): number => content.slice(0, index).split('\n').length;

      if (ext === '.json') {

        this.extractStepFunctions(content, relativePath, nodes, edges, entryPoints);
      } else if (ext === '.py') {
        this.extractCelery(content, lines, relativePath, nodes, entryPoints, jobNodeIds, pendingEnqueues);
        this.extractPythonTemporal(content, relativePath, nodes, edges, entryPoints, lineOf);


        this.extractKafka(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
      } else if (ext === '.rb') {
        this.extractSidekiq(content, lines, relativePath, nodes, entryPoints, jobNodeIds, pendingEnqueues);
      } else if (ext === '.go') {

        this.extractGoMessaging(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);

        this.extractGoCadence(content, relativePath, nodes, edges, entryPoints, lineOf);
      } else if (ext === '.rs') {

        this.extractRustMessaging(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
      } else if (ext === '.java') {

        this.extractJavaMessaging(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
      } else if (ext === '.cs') {

        this.extractCSharpMessaging(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
      } else {

        this.extractBullMQ(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, pendingQueueAdds, lineOf);
        this.extractKafka(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
        this.extractRabbitMQ(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
        this.extractNATS(content, relativePath, nodes, edges, entryPoints, ensureQueueNode, lineOf);
        this.extractTemporal(content, relativePath, nodes, edges, entryPoints, lineOf);
        this.extractDurableFunctions(content, relativePath, nodes, edges, entryPoints, lineOf);
        this.extractCamundaZeebe(content, relativePath, nodes, edges, entryPoints, lineOf);
      }
    }


    for (const enq of pendingEnqueues) {
      const targetId = jobNodeIds.get(`${enq.system}:${enq.jobName}`);
      if (!targetId) continue;
      const siteId = `flow_${enq.system}_enqueue_${this.sanitizeId(enq.jobName)}_${enq.line}`;
      nodes.push(
        this.createNode(siteId, `enqueue ${enq.jobName}`, 'enqueue', 4, enq.filePath, enq.line, undefined, {
          system: enq.system,
          target: enq.jobName,
          subcategories: ['async-flow', enq.system, 'enqueue'],
        })
      );
      edges.push(
        this.createEdge(
          `${siteId}__to__${targetId}`,
          siteId,
          targetId,
          'enqueues',
          'async-flow',
          { system: enq.system, jobName: enq.jobName }
        )
      );
    }


    for (const add of pendingQueueAdds) {
      const queueId = queueNodeIds.get(`bullmq:${add.queueName}`);
      const siteId = `flow_bullmq_add_${this.sanitizeId(add.queueName)}_${this.sanitizeId(add.jobName)}_${add.line}`;
      nodes.push(
        this.createNode(siteId, `add ${add.jobName}`, 'job', 4, add.filePath, add.line, undefined, {
          system: 'bullmq',
          queue: add.queueName,
          jobName: add.jobName,
          subcategories: ['async-flow', 'bullmq', 'job'],
        })
      );
      const targetId = queueId || ensureQueueNode('bullmq', add.queueName, add.filePath, add.line);
      edges.push(
        this.createEdge(
          `${siteId}__to__${targetId}`,
          siteId,
          targetId,
          'enqueues',
          'async-flow',
          { system: 'bullmq', queue: add.queueName, jobName: add.jobName }
        )
      );
    }

    return { nodes, edges, entryPoints };
  }


  private extractTemporal(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {
    const isWorkflowFile = /(^|\/)workflows?(\/|\.)/.test(filePath.replace(/\\/g, '/'));



    const proxiedActivities = new Set<string>();
    const proxyRe = /proxyActivities\s*</g;
    let m: RegExpExecArray | null;
    while ((m = proxyRe.exec(content)) !== null) {
      const line = lineOf(m.index);
      const id = `flow_temporal_activities_${this.sanitizeId(filePath)}_${line}`;
      nodes.push(
        this.createNode(id, 'proxyActivities', 'activity', 4, filePath, line, undefined, {
          system: 'temporal',
          subcategories: ['async-flow', 'temporal', 'activity'],
        })
      );

      const destructure = content.slice(Math.max(0, m.index - 200), m.index).match(/\{\s*([^}]+?)\s*\}\s*=\s*$/);
      if (destructure) {
        for (const raw of destructure[1].split(',')) {
          const name = raw.split(':')[0].trim();
          if (/^\w+$/.test(name)) proxiedActivities.add(name);
        }
      }
    }


    if (/(^|\/)activities?(\/|\.)/.test(filePath.replace(/\\/g, '/'))) {
      const fnRe = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
      while ((m = fnRe.exec(content)) !== null) {
        const name = m[1];
        const line = lineOf(m.index);
        const id = `flow_temporal_activity_${this.sanitizeId(name)}`;
        nodes.push(
          this.createNode(id, name, 'activity', 3, filePath, line, undefined, {
            system: 'temporal',
            subcategories: ['async-flow', 'temporal', 'activity'],
          })
        );
      }
    }

    if (!isWorkflowFile) return;


    const wfRe = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
    const workflowIds: string[] = [];
    while ((m = wfRe.exec(content)) !== null) {
      const name = m[1];
      const line = lineOf(m.index);
      const id = `flow_temporal_workflow_${this.sanitizeId(name)}`;
      workflowIds.push(id);
      nodes.push(
        this.createNode(id, name, 'workflow', 3, filePath, line, undefined, {
          system: 'temporal',
          subcategories: ['async-flow', 'temporal', 'workflow'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'event',
          name,
          `Temporal workflow ${name}`,
          { event: `temporal:workflow:${name}` },
          undefined,
          { system: 'temporal', kind: 'workflow' }
        )
      );
    }



    if (workflowIds.length === 0) return;
    const sourceWorkflow = workflowIds[0];
    const dispatched = new Set<string>();
    const execRe = /executeActivity\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = execRe.exec(content)) !== null) dispatched.add(m[1]);
    for (const act of Array.from(proxiedActivities)) {
      if (new RegExp(`\\b${act}\\s*\\(`).test(content)) dispatched.add(act);
    }
    for (const act of Array.from(dispatched)) {
      const activityId = `flow_temporal_activity_${this.sanitizeId(act)}`;
      this.addActivityDispatchEdge(sourceWorkflow, activityId, act, 'temporal', nodes, edges);
    }
  }






  private addActivityDispatchEdge(
    sourceId: string,
    activityId: string,
    activityName: string,
    system: WorkflowSystem,
    nodes: CASNode[],
    edges: CASEdge[]
  ): void {
    if (!nodes.some(n => n.id === activityId)) {
      nodes.push(this.createNode(activityId, activityName, 'activity', 3, undefined, undefined, undefined, {
        system,
        reference: true,
        subcategories: ['async-flow', system, 'activity'],
      }));
    }
    const edgeId = `${sourceId}__dispatches__${activityId}`;
    if (edges.some(e => e.id === edgeId)) return;
    edges.push(this.createEdge(edgeId, sourceId, activityId, 'dispatches', 'async-flow', { system, activity: activityName, async: true }));
  }


  private extractPythonTemporal(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {

    const wfDefnRe = /@workflow\.defn[\s\S]{0,200}?class\s+(\w+)/g;
    let m: RegExpExecArray | null;
    const workflowIds: string[] = [];
    while ((m = wfDefnRe.exec(content)) !== null) {
      const name = m[1];
      const line = lineOf(m.index);
      const id = `flow_temporal_workflow_${this.sanitizeId(name)}`;
      workflowIds.push(id);
      nodes.push(
        this.createNode(id, name, 'workflow', 3, filePath, line, undefined, {
          system: 'temporal',
          subcategories: ['async-flow', 'temporal', 'workflow'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'event',
          name,
          `Temporal workflow ${name}`,
          { event: `temporal:workflow:${name}` },
          undefined,
          { system: 'temporal', kind: 'workflow' }
        )
      );
    }

    const actDefnRe = /@activity\.defn[^\n]*\n\s*(?:async\s+)?def\s+(\w+)\s*\(/g;
    while ((m = actDefnRe.exec(content)) !== null) {
      const name = m[1];
      const line = lineOf(m.index);
      const id = `flow_temporal_activity_${this.sanitizeId(name)}`;
      nodes.push(
        this.createNode(id, name, 'activity', 3, filePath, line, undefined, {
          system: 'temporal',
          subcategories: ['async-flow', 'temporal', 'activity'],
        })
      );
    }


    if (workflowIds.length > 0) {
      const sourceWorkflow = workflowIds[0];
      const execRe = /(?:workflow\.)?execute_activity(?:_method)?\s*\(\s*([\w.]+)/g;
      const seen = new Set<string>();
      while ((m = execRe.exec(content)) !== null) {
        const ref = m[1].split('.').pop() || m[1];
        if (seen.has(ref)) continue;
        seen.add(ref);
        this.addActivityDispatchEdge(sourceWorkflow, `flow_temporal_activity_${this.sanitizeId(ref)}`, ref, 'temporal', nodes, edges);
      }
    }
  }


  private extractStepFunctions(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {

    if (!/"StartAt"/.test(content) || !/"States"/.test(content)) return;
    let doc: any;
    try {
      doc = JSON.parse(content);
    } catch {
      return;
    }
    const machine = this.findAslStateMachine(doc);
    if (!machine) return;

    const wfName = path.basename(filePath).replace(/\.(asl\.)?json$/i, '');
    const wfId = `flow_stepfunctions_workflow_${this.sanitizeId(wfName)}`;
    nodes.push(this.createNode(wfId, wfName, 'workflow', 3, filePath, undefined, undefined, {
      system: 'step-functions',
      startAt: machine.StartAt,
      subcategories: ['async-flow', 'step-functions', 'workflow'],
    }));
    entryPoints.push(this.createEntryPoint(`ep_${wfId}`, wfId, 'event', wfName, `AWS Step Functions state machine ${wfName}`, { event: `step-functions:workflow:${wfName}` }, undefined, { system: 'step-functions', kind: 'workflow' }));


    const walkStates = (states: Record<string, any>, parentId: string): void => {
      for (const [stateName, state] of Object.entries(states || {})) {
        if (!state || typeof state !== 'object') continue;
        const stateType = (state as any).Type || 'Task';
        const stateId = `flow_stepfunctions_state_${this.sanitizeId(wfName)}_${this.sanitizeId(stateName)}`;
        const isTask = stateType === 'Task';
        nodes.push(this.createNode(stateId, stateName, isTask ? 'activity' : 'step', isTask ? 3 : 4, filePath, undefined, undefined, {
          system: 'step-functions',
          stateType,
          resource: (state as any).Resource,
          subcategories: ['async-flow', 'step-functions', isTask ? 'activity' : 'step'],
        }));

        const edgeType = isTask ? 'dispatches' : 'transitions';
        edges.push(this.createEdge(`${parentId}__${edgeType}__${stateId}`, parentId, stateId, edgeType, 'async-flow', { system: 'step-functions', stateType, resource: (state as any).Resource, async: isTask }));

        for (const branch of (state as any).Branches || []) {
          if (branch?.States) walkStates(branch.States, stateId);
        }
        const iterator = (state as any).Iterator || (state as any).ItemProcessor;
        if (iterator?.States) walkStates(iterator.States, stateId);
      }
    };
    walkStates(machine.States, wfId);
  }

  private findAslStateMachine(doc: any): { StartAt: string; States: Record<string, any> } | undefined {
    if (doc && typeof doc === 'object' && doc.StartAt && doc.States) return doc;

    for (const key of ['definition', 'Definition', 'StateMachine', 'stateMachine']) {
      const nested = doc?.[key];
      if (nested?.StartAt && nested?.States) return nested;
    }
    return undefined;
  }


  private extractDurableFunctions(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {

    if (!/df\.orchestrator|durable-functions|IDurableOrchestrationContext|DurableOrchestrationContext/.test(content)) return;

    const wfName = path.basename(filePath).replace(/\.[jt]s$/i, '');
    const wfId = `flow_durablefunctions_orchestrator_${this.sanitizeId(wfName)}`;
    nodes.push(this.createNode(wfId, wfName, 'workflow', 3, filePath, undefined, undefined, {
      system: 'durable-functions',
      subcategories: ['async-flow', 'durable-functions', 'orchestrator'],
    }));
    entryPoints.push(this.createEntryPoint(`ep_${wfId}`, wfId, 'event', wfName, `Azure Durable Functions orchestrator ${wfName}`, { event: `durable-functions:orchestrator:${wfName}` }, undefined, { system: 'durable-functions', kind: 'orchestrator' }));


    const actRe = /call(?:Sub[Oo]rchestrator|Activity)(?:WithRetry)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = actRe.exec(content)) !== null) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      this.addActivityDispatchEdge(wfId, `flow_durablefunctions_activity_${this.sanitizeId(name)}`, name, 'durable-functions', nodes, edges);
    }
  }


  private extractCamundaZeebe(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {
    if (!/ZBClient|ZeebeClient|createWorker|zeebe/i.test(content)) return;

    const wfName = path.basename(filePath).replace(/\.[jt]s$/i, '');
    const wfId = `flow_camundazeebe_workflow_${this.sanitizeId(wfName)}`;
    let created = false;
    const ensureWf = (): string => {
      if (!created) {
        created = true;
        nodes.push(this.createNode(wfId, wfName, 'workflow', 3, filePath, undefined, undefined, {
          system: 'camunda-zeebe',
          subcategories: ['async-flow', 'camunda-zeebe', 'workflow'],
        }));
        entryPoints.push(this.createEntryPoint(`ep_${wfId}`, wfId, 'event', wfName, `Camunda/Zeebe worker host ${wfName}`, { event: `camunda-zeebe:workflow:${wfName}` }, undefined, { system: 'camunda-zeebe', kind: 'workflow' }));
      }
      return wfId;
    };


    const workerRe = /createWorker\s*\(\s*(?:\{[\s\S]{0,160}?taskType\s*:\s*(['"`])([^'"`]+)\1|(['"`])([^'"`]+)\3)/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = workerRe.exec(content)) !== null) {
      const taskType = m[2] || m[4];
      if (!taskType || seen.has(taskType)) continue;
      seen.add(taskType);
      const source = ensureWf();
      const activityId = `flow_camundazeebe_activity_${this.sanitizeId(taskType)}`;
      nodes.push(this.createNode(activityId, taskType, 'activity', 3, filePath, lineOf(m.index), undefined, {
        system: 'camunda-zeebe',
        taskType,
        subcategories: ['async-flow', 'camunda-zeebe', 'activity'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${activityId}`, activityId, 'event', `${taskType} worker`, `Zeebe job worker for task type ${taskType}`, { event: `camunda-zeebe:task:${taskType}` }, undefined, { system: 'camunda-zeebe', kind: 'job-worker', taskType }));
      edges.push(this.createEdge(`${source}__dispatches__${activityId}`, source, activityId, 'dispatches', 'async-flow', { system: 'camunda-zeebe', taskType, async: true }));
    }
  }


  private extractGoCadence(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    lineOf: (index: number) => number
  ): void {
    if (!/go\.uber\.org\/cadence|go\.temporal\.io|workflow\.ExecuteActivity|RegisterWorkflow/.test(content)) return;
    const system: WorkflowSystem = /cadence/.test(content) ? 'cadence' : 'temporal';


    const wfRe = /func\s+(\w*[Ww]orkflow\w*)\s*\(\s*ctx\s+workflow\.Context/g;
    let m: RegExpExecArray | null;
    let sourceWorkflow: string | undefined;
    while ((m = wfRe.exec(content)) !== null) {
      const name = m[1];
      const id = `flow_${system}_workflow_${this.sanitizeId(name)}`;
      if (!sourceWorkflow) sourceWorkflow = id;
      nodes.push(this.createNode(id, name, 'workflow', 3, filePath, lineOf(m.index), undefined, {
        system,
        subcategories: ['async-flow', system, 'workflow'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', name, `${system} workflow ${name}`, { event: `${system}:workflow:${name}` }, undefined, { system, kind: 'workflow' }));
    }

    if (!sourceWorkflow) return;

    const execRe = /workflow\.ExecuteActivity\s*\(\s*[\w.]+\s*,\s*([\w.]+)/g;
    const seen = new Set<string>();
    while ((m = execRe.exec(content)) !== null) {
      const ref = m[1].split('.').pop() || m[1];
      if (seen.has(ref)) continue;
      seen.add(ref);
      this.addActivityDispatchEdge(sourceWorkflow, `flow_${system}_activity_${this.sanitizeId(ref)}`, ref, system, nodes, edges);
    }
  }


  private extractCelery(
    content: string,
    lines: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    jobNodeIds: Map<string, string>,
    pendingEnqueues: Array<{ system: WorkflowSystem; jobName: string; filePath: string; line: number }>
  ): void {

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/@(?:\w+\.)?(?:shared_task|task)\b/.test(line) || /@shared_task\b/.test(line)) {

        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const defMatch = lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
          if (defMatch) {
            const name = defMatch[1];
            const id = `flow_celery_task_${this.sanitizeId(name)}`;
            if (!jobNodeIds.has(`celery:${name}`)) {
              jobNodeIds.set(`celery:${name}`, id);
              nodes.push(
                this.createNode(id, name, 'job', 3, filePath, j + 1, undefined, {
                  system: 'celery',
                  kind: 'task',
                  subcategories: ['async-flow', 'celery', 'task'],
                })
              );
              entryPoints.push(
                this.createEntryPoint(
                  `ep_${id}`,
                  id,
                  'event',
                  name,
                  `Celery task ${name}`,
                  { event: `celery:task:${name}` },
                  undefined,
                  { system: 'celery', kind: 'task' }
                )
              );
            }
            break;
          }
        }
      }
    }


    const enqueueRe = /(\w+)\.(?:delay|apply_async)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = enqueueRe.exec(content)) !== null) {
      const jobName = m[1];
      const line = content.slice(0, m.index).split('\n').length;
      pendingEnqueues.push({ system: 'celery', jobName, filePath, line });
    }
  }


  private extractSidekiq(
    content: string,
    lines: string[],
    filePath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    jobNodeIds: Map<string, string>,
    pendingEnqueues: Array<{ system: WorkflowSystem; jobName: string; filePath: string; line: number }>
  ): void {

    const classRe = /class\s+(\w+)[\s\S]*?include\s+Sidekiq::(?:Job|Worker)/g;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[1];
      const line = content.slice(0, m.index).split('\n').length;
      const id = `flow_sidekiq_worker_${this.sanitizeId(name)}`;
      if (!jobNodeIds.has(`sidekiq:${name}`)) {
        jobNodeIds.set(`sidekiq:${name}`, id);
        nodes.push(
          this.createNode(id, name, 'worker', 3, filePath, line, undefined, {
            system: 'sidekiq',
            kind: 'worker',
            subcategories: ['async-flow', 'sidekiq', 'worker'],
          })
        );
        entryPoints.push(
          this.createEntryPoint(
            `ep_${id}`,
            id,
            'event',
            name,
            `Sidekiq worker ${name}`,
            { event: `sidekiq:worker:${name}` },
            undefined,
            { system: 'sidekiq', kind: 'worker' }
          )
        );
      }
    }


    const enqueueRe = /(\w+)\.(?:perform_async|perform_in|perform_at|set\s*\([^)]*\)\.perform_async)\s*\(?/g;
    while ((m = enqueueRe.exec(content)) !== null) {
      const jobName = m[1];
      const line = content.slice(0, m.index).split('\n').length;
      pendingEnqueues.push({ system: 'sidekiq', jobName, filePath, line });
    }
  }


  private extractBullMQ(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    pendingQueueAdds: Array<{ queueName: string; jobName: string; filePath: string; line: number }>,
    lineOf: (index: number) => number
  ): void {


    const varToQueue = new Map<string, string>();
    const bindingRe =
      /(?:const|let|var)\s+(\w+)\s*=\s*new\s+Queue\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = bindingRe.exec(content)) !== null) {
      varToQueue.set(m[1], m[2]);
    }

    const queueRe = /new\s+Queue\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = queueRe.exec(content)) !== null) {
      ensureQueueNode('bullmq', m[1], filePath, lineOf(m.index));
    }


    const workerRe = /new\s+Worker\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = workerRe.exec(content)) !== null) {
      const queueName = m[1];
      const line = lineOf(m.index);
      const queueId = ensureQueueNode('bullmq', queueName, filePath, line);
      const id = `flow_bullmq_worker_${this.sanitizeId(queueName)}_${line}`;
      nodes.push(
        this.createNode(id, queueName, 'worker', 3, filePath, line, undefined, {
          system: 'bullmq',
          kind: 'worker',
          queue: queueName,
          subcategories: ['async-flow', 'bullmq', 'worker'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'event',
          `${queueName} worker`,
          `BullMQ worker consuming queue ${queueName}`,
          { event: `bullmq:queue:${queueName}` },
          undefined,
          { system: 'bullmq', kind: 'worker', queue: queueName }
        )
      );

      edges.push(
        this.createEdge(`${queueId}__to__${id}`, queueId, id, 'consumes', 'async-flow', {
          system: 'bullmq',
          queue: queueName,
        })
      );
    }


    const addRe = /(\w+)\.add\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = addRe.exec(content)) !== null) {
      const varName = m[1];
      const jobName = m[2];
      const line = lineOf(m.index);

      const queueName = varToQueue.get(varName) || varName;
      pendingQueueAdds.push({ queueName, jobName, filePath, line });
    }
  }


  private extractKafka(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {

    const subRe = /\.subscribe\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    const hasRun = /\.run\s*\(\s*\{[^}]*eachMessage/.test(content);
    while ((m = subRe.exec(content)) !== null) {
      const topic = m[1];
      const line = lineOf(m.index);
      const topicId = ensureQueueNode('kafka', topic, filePath, line);
      const id = `flow_kafka_consumer_${this.sanitizeId(topic)}_${line}`;
      nodes.push(
        this.createNode(id, `${topic} consumer`, 'consumer', 3, filePath, line, undefined, {
          system: 'kafka',
          kind: 'consumer',
          topic,
          hasEachMessage: hasRun,
          subcategories: ['async-flow', 'kafka', 'consumer'],
        })
      );
      entryPoints.push(
        this.createEntryPoint(
          `ep_${id}`,
          id,
          'event',
          `${topic} consumer`,
          `Kafka consumer for topic ${topic}`,
          { event: `kafka:topic:${topic}` },
          undefined,
          { system: 'kafka', kind: 'consumer', topic }
        )
      );
      edges.push(
        this.createEdge(`${topicId}__to__${id}`, topicId, id, 'consumes', 'async-flow', {
          system: 'kafka',
          topic,
        })
      );
    }


    const sendRe = /\.send\s*\(\s*\{[^}]*topic\s*:\s*['"`]([^'"`]+)['"`]/g;
    while ((m = sendRe.exec(content)) !== null) {
      const topic = m[1];
      const line = lineOf(m.index);
      const topicId = ensureQueueNode('kafka', topic, filePath, line);
      const id = `flow_kafka_producer_${this.sanitizeId(topic)}_${line}`;
      nodes.push(
        this.createNode(id, `${topic} producer`, 'producer', 4, filePath, line, undefined, {
          system: 'kafka',
          kind: 'producer',
          topic,
          subcategories: ['async-flow', 'kafka', 'producer'],
        })
      );
      edges.push(
        this.createEdge(`${id}__to__${topicId}`, id, topicId, 'produces', 'async-flow', {
          system: 'kafka',
          topic,
        })
      );
    }




    if (/kafka/i.test(content)) {
      const pySend = /\.send\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g;
      while ((m = pySend.exec(content)) !== null) {
        const topic = m[1];
        const line = lineOf(m.index);
        const topicId = ensureQueueNode('kafka', topic, filePath, line);
        const id = `flow_kafka_producer_${this.sanitizeId(topic)}_${line}`;
        if (nodes.some(n => n.id === id)) continue;
        nodes.push(this.createNode(id, `${topic} producer`, 'producer', 4, filePath, line, undefined, {
          system: 'kafka', kind: 'producer', topic, subcategories: ['async-flow', 'kafka', 'producer'],
        }));
        edges.push(this.createEdge(`${id}__to__${topicId}`, id, topicId, 'produces', 'async-flow', { system: 'kafka', topic }));
      }
      const pyConsumer = /KafkaConsumer\s*\(\s*['"`]([^'"`]+)['"`]|\.subscribe\s*\(\s*\[\s*['"`]([^'"`]+)['"`]/g;
      while ((m = pyConsumer.exec(content)) !== null) {
        const topic = m[1] || m[2];
        const line = lineOf(m.index);
        const topicId = ensureQueueNode('kafka', topic, filePath, line);
        const id = `flow_kafka_consumer_${this.sanitizeId(topic)}_${line}`;
        if (nodes.some(n => n.id === id)) continue;
        nodes.push(this.createNode(id, `${topic} consumer`, 'consumer', 3, filePath, line, undefined, {
          system: 'kafka', kind: 'consumer', topic, subcategories: ['async-flow', 'kafka', 'consumer'],
        }));
        entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${topic} consumer`, `Kafka consumer for topic ${topic}`, { event: `kafka:topic:${topic}` }, undefined, { system: 'kafka', kind: 'consumer', topic }));
        edges.push(this.createEdge(`${topicId}__to__${id}`, topicId, id, 'consumes', 'async-flow', { system: 'kafka', topic }));
      }
    }
  }


  private extractRabbitMQ(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {

    const sendRe = /\.sendToQueue\s*\(\s*['"`]([^'"`]+)['"`]|\.publish\s*\(\s*['"`][^'"`]*['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = sendRe.exec(content)) !== null) {
      const queue = m[1] || m[2];
      if (!queue) continue;
      const line = lineOf(m.index);
      const queueId = ensureQueueNode('rabbitmq', queue, filePath, line);
      const id = `flow_rabbitmq_producer_${this.sanitizeId(queue)}_${line}`;
      nodes.push(this.createNode(id, `${queue} producer`, 'producer', 4, filePath, line, undefined, {
        system: 'rabbitmq', kind: 'producer', topic: queue, subcategories: ['async-flow', 'rabbitmq', 'producer'],
      }));
      edges.push(this.createEdge(`${id}__to__${queueId}`, id, queueId, 'produces', 'async-flow', { system: 'rabbitmq', topic: queue }));
    }


    const consumeRe = /\.consume\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = consumeRe.exec(content)) !== null) {
      const queue = m[1];
      const line = lineOf(m.index);
      const queueId = ensureQueueNode('rabbitmq', queue, filePath, line);
      const id = `flow_rabbitmq_consumer_${this.sanitizeId(queue)}_${line}`;
      nodes.push(this.createNode(id, `${queue} consumer`, 'consumer', 3, filePath, line, undefined, {
        system: 'rabbitmq', kind: 'consumer', topic: queue, subcategories: ['async-flow', 'rabbitmq', 'consumer'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${queue} consumer`, `RabbitMQ consumer for queue ${queue}`, { event: `rabbitmq:queue:${queue}` }, undefined, { system: 'rabbitmq', kind: 'consumer', topic: queue }));
      edges.push(this.createEdge(`${queueId}__to__${id}`, queueId, id, 'consumes', 'async-flow', { system: 'rabbitmq', topic: queue }));
    }
  }


  private extractNATS(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {



    if (!/\bnats\b/.test(content)) return;

    const pubRe = /\.publish\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = pubRe.exec(content)) !== null) {
      const subject = m[1];
      const line = lineOf(m.index);
      const subjectId = ensureQueueNode('nats', subject, filePath, line);
      const id = `flow_nats_producer_${this.sanitizeId(subject)}_${line}`;
      nodes.push(this.createNode(id, `${subject} producer`, 'producer', 4, filePath, line, undefined, {
        system: 'nats', kind: 'producer', topic: subject, subcategories: ['async-flow', 'nats', 'producer'],
      }));
      edges.push(this.createEdge(`${id}__to__${subjectId}`, id, subjectId, 'produces', 'async-flow', { system: 'nats', topic: subject }));
    }

    const subRe = /\.subscribe\s*\(\s*['"`]([^'"`]+)['"`]/g;
    while ((m = subRe.exec(content)) !== null) {
      const subject = m[1];
      const line = lineOf(m.index);
      const subjectId = ensureQueueNode('nats', subject, filePath, line);
      const id = `flow_nats_consumer_${this.sanitizeId(subject)}_${line}`;
      nodes.push(this.createNode(id, `${subject} consumer`, 'consumer', 3, filePath, line, undefined, {
        system: 'nats', kind: 'consumer', topic: subject, subcategories: ['async-flow', 'nats', 'consumer'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${subject} consumer`, `NATS subscriber for subject ${subject}`, { event: `nats:subject:${subject}` }, undefined, { system: 'nats', kind: 'consumer', topic: subject }));
      edges.push(this.createEdge(`${subjectId}__to__${id}`, subjectId, id, 'consumes', 'async-flow', { system: 'nats', topic: subject }));
    }
  }


  private extractGoMessaging(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {
    const emitProducer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_producer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} producer`, 'producer', 4, filePath, line, undefined, {
        system, kind: 'producer', topic, subcategories: ['async-flow', system, 'producer'],
      }));
      edges.push(this.createEdge(`${id}__to__${topicId}`, id, topicId, 'produces', 'async-flow', { system, topic }));
    };
    const emitConsumer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_consumer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} consumer`, 'consumer', 3, filePath, line, undefined, {
        system, kind: 'consumer', topic, subcategories: ['async-flow', system, 'consumer'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${topic} consumer`, `${system} consumer for ${topic}`, { event: `${system}:topic:${topic}` }, undefined, { system, kind: 'consumer', topic }));
      edges.push(this.createEdge(`${topicId}__to__${id}`, topicId, id, 'consumes', 'async-flow', { system, topic }));
    };

    let m: RegExpExecArray | null;

    const writerRe = /kafka\.(?:NewWriter\s*\(\s*)?(?:kafka\.)?Writer(?:Config)?\s*\{[\s\S]{0,300}?Topic\s*:\s*"([^"]+)"/g;
    while ((m = writerRe.exec(content)) !== null) emitProducer('kafka', m[1], lineOf(m.index));
    const readerRe = /kafka\.(?:NewReader\s*\(\s*)?(?:kafka\.)?Reader(?:Config)?\s*\{[\s\S]{0,300}?Topic\s*:\s*"([^"]+)"/g;
    while ((m = readerRe.exec(content)) !== null) emitConsumer('kafka', m[1], lineOf(m.index));



    if (/\bnats\b/.test(content)) {
      const pubRe = /\.Publish\s*\(\s*"([^"]+)"/g;
      while ((m = pubRe.exec(content)) !== null) emitProducer('nats', m[1], lineOf(m.index));
      const subRe = /\.(?:Queue)?Subscribe\s*\(\s*"([^"]+)"/g;
      while ((m = subRe.exec(content)) !== null) emitConsumer('nats', m[1], lineOf(m.index));
    }
  }


  private extractRustMessaging(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {
    const emitProducer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_producer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} producer`, 'producer', 4, filePath, line, undefined, {
        system, kind: 'producer', topic, subcategories: ['async-flow', system, 'producer'],
      }));
      edges.push(this.createEdge(`${id}__to__${topicId}`, id, topicId, 'produces', 'async-flow', { system, topic }));
    };
    const emitConsumer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_consumer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} consumer`, 'consumer', 3, filePath, line, undefined, {
        system, kind: 'consumer', topic, subcategories: ['async-flow', system, 'consumer'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${topic} consumer`, `${system} consumer for ${topic}`, { event: `${system}:topic:${topic}` }, undefined, { system, kind: 'consumer', topic }));
      edges.push(this.createEdge(`${topicId}__to__${id}`, topicId, id, 'consumes', 'async-flow', { system, topic }));
    };

    let m: RegExpExecArray | null;


    const recordRe = /FutureRecord::to\s*\(\s*"([^"]+)"/g;
    while ((m = recordRe.exec(content)) !== null) emitProducer('kafka', m[1], lineOf(m.index));
    const sliceSubRe = /\.subscribe\s*\(\s*&\[([\s\S]{0,200}?)\]/g;
    while ((m = sliceSubRe.exec(content)) !== null) {
      const line = lineOf(m.index);
      const topicRe = /"([^"]+)"/g;
      let t: RegExpExecArray | null;
      while ((t = topicRe.exec(m[1])) !== null) emitConsumer('kafka', t[1], line);
    }




    if (/async[_-]nats|\bnats\b/.test(content)) {
      const pubRe = /\.publish\s*\(\s*"([^"]+)"/g;
      while ((m = pubRe.exec(content)) !== null) emitProducer('nats', m[1], lineOf(m.index));

      const subRe = /\.subscribe\s*\(\s*"([^"]+)"/g;
      while ((m = subRe.exec(content)) !== null) emitConsumer('nats', m[1], lineOf(m.index));
    }
  }


  private brokerEmitters(
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string
  ): {
    emitProducer: (system: WorkflowSystem, topic: string, line: number) => void;
    emitConsumer: (system: WorkflowSystem, topic: string, line: number) => void;
  } {
    const emitProducer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_producer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} producer`, 'producer', 4, filePath, line, undefined, {
        system, kind: 'producer', topic, subcategories: ['async-flow', system, 'producer'],
      }));
      edges.push(this.createEdge(`${id}__to__${topicId}`, id, topicId, 'produces', 'async-flow', { system, topic }));
    };
    const emitConsumer = (system: WorkflowSystem, topic: string, line: number): void => {
      const topicId = ensureQueueNode(system, topic, filePath, line);
      const id = `flow_${system}_consumer_${this.sanitizeId(topic)}_${line}`;
      if (nodes.some(n => n.id === id)) return;
      nodes.push(this.createNode(id, `${topic} consumer`, 'consumer', 3, filePath, line, undefined, {
        system, kind: 'consumer', topic, subcategories: ['async-flow', system, 'consumer'],
      }));
      entryPoints.push(this.createEntryPoint(`ep_${id}`, id, 'event', `${topic} consumer`, `${system} consumer for ${topic}`, { event: `${system}:topic:${topic}` }, undefined, { system, kind: 'consumer', topic }));
      edges.push(this.createEdge(`${topicId}__to__${id}`, topicId, id, 'consumes', 'async-flow', { system, topic }));
    };
    return { emitProducer, emitConsumer };
  }


  private extractJavaMessaging(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {

    if (!/KafkaTemplate|@KafkaListener|org\.apache\.kafka|spring-kafka/.test(content)) return;
    const { emitProducer, emitConsumer } = this.brokerEmitters(filePath, nodes, edges, entryPoints, ensureQueueNode);

    let m: RegExpExecArray | null;

    const sendRe = /\.send\s*\(\s*"([^"]+)"/g;
    while ((m = sendRe.exec(content)) !== null) emitProducer('kafka', m[1], lineOf(m.index));


    const listenerRe = /@KafkaListener\s*\([^)]*?topics\s*=\s*(\{[^}]*\}|"[^"]+")/g;
    while ((m = listenerRe.exec(content)) !== null) {
      const line = lineOf(m.index);
      const topicRe = /"([^"]+)"/g;
      let t: RegExpExecArray | null;
      while ((t = topicRe.exec(m[1])) !== null) emitConsumer('kafka', t[1], line);
    }
  }


  private extractCSharpMessaging(
    content: string,
    filePath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    ensureQueueNode: (system: WorkflowSystem, name: string, filePath: string, line?: number) => string,
    lineOf: (index: number) => number
  ): void {

    if (!/Confluent\.Kafka|IProducer|IConsumer|ProduceAsync/.test(content)) return;
    const { emitProducer, emitConsumer } = this.brokerEmitters(filePath, nodes, edges, entryPoints, ensureQueueNode);

    let m: RegExpExecArray | null;

    const produceRe = /\.Produce(?:Async)?\s*\(\s*"([^"]+)"/g;
    while ((m = produceRe.exec(content)) !== null) emitProducer('kafka', m[1], lineOf(m.index));


    const subRe = /\.Subscribe\s*\(\s*"([^"]+)"/g;
    while ((m = subRe.exec(content)) !== null) emitConsumer('kafka', m[1], lineOf(m.index));
  }

  private async collectDependencyNames(projectPath: string): Promise<Set<string>> {
    const names = new Set<string>();
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        for (const d of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          names.add(d);
        }
      }
    } catch {

    }

    try {
      const reqPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(reqPath)) {
        const txt = await fs.readFile(reqPath, 'utf-8');
        for (const line of txt.split('\n')) {
          const name = line.split(/[=<>~\[]/)[0].trim().toLowerCase();
          if (name) names.add(name);
        }
      }
    } catch {

    }

    try {
      const gemPath = path.join(projectPath, 'Gemfile');
      if (await fs.pathExists(gemPath)) {
        const txt = await fs.readFile(gemPath, 'utf-8');
        const gemRe = /gem\s+['"]([^'"]+)['"]/g;
        let g: RegExpExecArray | null;
        while ((g = gemRe.exec(txt)) !== null) names.add(g[1].toLowerCase());
      }
    } catch {

    }
    return names;
  }

  protected getCapabilities(): string[] {
    return [
      'temporal-workflows',
      'temporal-activity-dispatch-edges',
      'celery-tasks',
      'sidekiq-jobs',
      'bullmq-queues',
      'kafka-consumers',
      'async-flows',
      'step-functions-state-machines',
      'durable-functions-orchestrators',
      'camunda-zeebe-workers',
      'cadence-workflows',
      'orchestrator-activity-dispatch-edges',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1:
        return 'system';
      case 2:
        return 'architectural';
      case 3:
        return 'code';
      case 4:
        return 'member';
      case 5:
        return 'implementation';
      default:
        return 'unknown';
    }
  }
}
