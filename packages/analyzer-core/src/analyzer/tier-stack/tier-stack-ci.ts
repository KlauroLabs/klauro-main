import type { CASEdge, CASEntryPoint, CASNode } from '../../types/cas.types';
import type { TierStackIndex } from './read-tier-stack';

const TIER_STACK_ANALYZER = 'tier-stack';
const TARGET_PREFIX = 'ci_target:';

interface TierStackCiStep {
  id: string;
  name?: string;
  line: number;
  command?: string;
  action?: string;
  purpose?: string;
  deploy_target?: string;
  paths?: string[];
  env_refs?: string[];
  secret_refs?: string[];
}

interface TierStackCiJob {
  id: string;
  name: string;
  line: number;
  stage?: string;
  environment?: string;
  needs?: string[];
  requires?: string[];
  rules?: string[];
  env_refs?: string[];
  secret_refs?: string[];
  depends_on?: Array<{ job: string; reason: string }>;
  steps: TierStackCiStep[];
}

interface TierStackCiStage {
  id: string;
  name: string;
  line: number;
  jobs: string[];
}

interface TierStackCiTrigger {
  event: string;
  kind: 'event' | 'schedule';
  schedule?: string;
  pattern?: string;
  line: number;
}

interface TierStackCiPipeline {
  id: string;
  name: string;
  provider: string;
  file: number;
  line: number;
  triggers: TierStackCiTrigger[];
  stages: TierStackCiStage[];
  jobs: TierStackCiJob[];
}

interface Carried {
  ci?: TierStackCiPipeline[];
}

function pipelinesOf(index: TierStackIndex): TierStackCiPipeline[] {
  return (index as unknown as Carried).ci ?? [];
}

function present(held: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(held).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)),
  );
}

function ciNode(id: string, name: string, type: string, file: string | undefined, line: number, attributes: Record<string, unknown>): CASNode {
  return {
    id,
    name,
    type,
    analyzers: [TIER_STACK_ANALYZER],
    primaryAnalyzer: TIER_STACK_ANALYZER,
    source: { file, line },
    metadata: { attributes: present(attributes) },
  } as CASNode;
}

export function ciNodesOf(index: TierStackIndex): CASNode[] {
  const nodes: CASNode[] = [];
  const targets = new Set<string>();
  for (const pipeline of pipelinesOf(index)) {
    const file = index.files[pipeline.file]?.path;
    nodes.push(ciNode(pipeline.id, pipeline.name, 'ci_pipeline', file, pipeline.line, {
      provider: pipeline.provider,
      triggers: pipeline.triggers.map(trigger => trigger.event),
    }));
    for (const stage of pipeline.stages) {
      nodes.push(ciNode(stage.id, stage.name, 'ci_stage', file, stage.line, { jobs: stage.jobs }));
    }
    for (const job of pipeline.jobs) {
      nodes.push(ciNode(job.id, job.name, 'ci_job', file, job.line, {
        stage: job.stage,
        environment: job.environment,
        needs: job.needs,
        requires: job.requires,
        rules: job.rules,
        env_refs: job.env_refs,
        secret_refs: job.secret_refs,
      }));
      for (const step of job.steps) {
        nodes.push(ciNode(step.id, step.name ?? step.command ?? step.action ?? step.id, 'ci_step', file, step.line, {
          command: step.command,
          action: step.action,
          purpose: step.purpose,
          deploy_target: step.deploy_target,
          paths: step.paths,
          env_refs: step.env_refs,
          secret_refs: step.secret_refs,
        }));
        if (step.deploy_target !== undefined) targets.add(step.deploy_target);
      }
    }
  }
  for (const target of targets) nodes.push(ciNode(`${TARGET_PREFIX}${target}`, target, 'deploy_target', undefined, 1, {}));
  return nodes;
}

export function ciEdgesOf(index: TierStackIndex, first: number): CASEdge[] {
  const edges: Array<Omit<CASEdge, 'id'>> = [];
  for (const pipeline of pipelinesOf(index)) {
    for (const stage of pipeline.stages) edges.push({ source: pipeline.id, target: stage.id, type: 'contains' });
    for (const job of pipeline.jobs) {
      edges.push({ source: pipeline.id, target: job.id, type: 'contains' });
      for (const dependency of job.depends_on ?? []) {
        edges.push({
          source: job.id,
          target: dependency.job,
          type: 'depends_on',
          metadata: { reason: dependency.reason, dependency: dependency.reason } as CASEdge['metadata'],
        });
      }
      for (const step of job.steps) {
        edges.push({ source: job.id, target: step.id, type: 'contains' });
        if (step.deploy_target !== undefined) {
          edges.push({ source: step.id, target: `${TARGET_PREFIX}${step.deploy_target}`, type: 'deploys_to' });
        }
      }
    }
  }
  return edges.map((edge, at) => ({ id: `edge:${first + at}`, ...edge }));
}

export function ciEntryPointsOf(index: TierStackIndex): CASEntryPoint[] {
  return pipelinesOf(index).flatMap(pipeline =>
    pipeline.triggers.map((trigger, at) => ({
      id: `${pipeline.id}#trigger:${at}`,
      source_node: pipeline.id,
      source_analyzer: TIER_STACK_ANALYZER,
      type: trigger.kind,
      name: trigger.event,
      trigger: present({ event: trigger.event, schedule: trigger.schedule, pattern: trigger.pattern }),
      handler: {
        node_id: pipeline.id,
        method_name: pipeline.name,
        file: index.files[pipeline.file]?.path,
        line: trigger.line,
      },
      metadata: { registrar: pipeline.provider },
    })) as CASEntryPoint[],
  );
}
