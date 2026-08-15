import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASEntryPoint, CASExitPoint, CASNode } from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as yaml from 'js-yaml';

type CiProvider =
  | 'github-actions'
  | 'gitlab-ci'
  | 'circleci'
  | 'jenkins'
  | 'azure-pipelines'
  | 'travis-ci'
  | 'drone'
  | 'buildkite'
  | 'bitbucket-pipelines'
  | 'teamcity';

interface CiConfigFile {
  provider: CiProvider;
  file: string;
}

interface CiPipeline {
  id: string;
  name: string;
  provider: CiProvider;
  file: string;
  line: number;
  triggers: CiTrigger[];
  jobs: CiJob[];
  stages: CiStage[];
  metadata?: Record<string, any>;
}

interface CiStage {
  id: string;
  name: string;
  file: string;
  line: number;
  jobs: string[];
}

interface CiJob {
  id: string;
  name: string;
  file: string;
  line: number;
  stage?: string;
  needs: string[];
  requires: string[];
  environment?: string;
  matrix?: unknown;
  rules: string[];
  steps: CiStep[];
  envRefs: string[];
  secretRefs: string[];
  metadata?: Record<string, any>;
}

interface CiStep {
  id: string;
  name: string;
  file: string;
  line: number;
  command?: string;
  action?: string;
  deployTarget?: string;
  envRefs: string[];
  secretRefs: string[];
  metadata?: Record<string, any>;
}

interface CiTrigger {
  type: CASEntryPoint['type'];
  event: string;
  schedule?: string;
  line?: number;
  metadata?: Record<string, any>;
}

const CONFIG_PATTERNS = [
  '.github/workflows/*.yml',
  '.github/workflows/*.yaml',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'Jenkinsfile',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.travis.yml',
  '.drone.yml',
  '.drone.yaml',
  '.buildkite/pipeline.yml',
  '.buildkite/pipeline.yaml',
  'bitbucket-pipelines.yml',
  'bitbucket-pipelines.yaml',
  '.teamcity/**/*.kt',
  '.teamcity/**/*.kts',
];

const RESERVED_GITLAB_KEYS = new Set([
  'stages',
  'types',
  'workflow',
  'variables',
  'include',
  'default',
  'image',
  'services',
  'before_script',
  'after_script',
  'cache',
]);

const DEPLOY_MARKER = /\b(deploy|release|publish|docker\/build-push-action|kubectl|helm|serverless|sam deploy|cdk deploy|terraform apply|pages|npm publish|cargo publish|gh release)\b/i;

export class CiPipelineAnalyzer extends BaseAnalyzer {
  constructor() {
    super('ci-pipeline', 'CI/CD Pipeline Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      return (await this.findConfigFiles(projectPath)).length > 0;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const configs = await this.findConfigFiles(context.projectPath);
      const pipelines: CiPipeline[] = [];

      for (const config of configs) {
        const content = await fs.readFile(path.join(context.projectPath, config.file), 'utf-8').catch(() => '');
        if (!content) continue;
        pipelines.push(...this.extractPipelines(config, content));
      }

      for (const pipeline of pipelines) {
        this.emitPipeline(pipeline, nodes, edges, entryPoints, exitPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'ci-pipeline',
          pipeline_count: pipelines.length,
          job_count: pipelines.reduce((sum, pipeline) => sum + pipeline.jobs.length, 0),
          stage_count: pipelines.reduce((sum, pipeline) => sum + pipeline.stages.length, 0),
          step_count: pipelines.reduce((sum, pipeline) => sum + pipeline.jobs.reduce((jobSum, job) => jobSum + job.steps.length, 0), 0),
          trigger_count: pipelines.reduce((sum, pipeline) => sum + pipeline.triggers.length, 0),
          providers: Array.from(new Set(pipelines.map(pipeline => pipeline.provider))),
          teamcity_detected: configs.some(config => config.provider === 'teamcity'),
        },
      });
    } catch (error) {
      throw new AnalyzerError(
        `CI/CD pipeline analysis failed: ${(error as Error).message}`,
        'CI_PIPELINE_ANALYSIS_ERROR'
      );
    }
  }

  protected getCapabilities(): string[] {
    return [
      'ci-config-file-detection',
      'pipeline-trigger-detection',
      'ci-job-and-stage-graph',
      'ci-step-command-and-action-detection',
      'ci-secret-and-env-reference-detection',
      'ci-deploy-target-detection',
    ];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'delivery system';
      case 2: return 'pipeline';
      case 3: return 'job or stage';
      case 4: return 'step';
      default: return `ci-level-${level}`;
    }
  }

  private async findConfigFiles(projectPath: string): Promise<CiConfigFile[]> {
    const files = await glob(CONFIG_PATTERNS, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
      absolute: false,
    });

    return files.sort().map(file => ({ provider: this.providerForFile(file), file }));
  }

  private providerForFile(file: string): CiProvider {
    if (file.startsWith('.github/workflows/')) return 'github-actions';
    if (file === '.gitlab-ci.yml') return 'gitlab-ci';
    if (file === '.circleci/config.yml') return 'circleci';
    if (file === 'Jenkinsfile') return 'jenkins';
    if (file === 'azure-pipelines.yml' || file === 'azure-pipelines.yaml') return 'azure-pipelines';
    if (file === '.travis.yml') return 'travis-ci';
    if (file === '.drone.yml' || file === '.drone.yaml') return 'drone';
    if (file === '.buildkite/pipeline.yml' || file === '.buildkite/pipeline.yaml') return 'buildkite';
    if (file === 'bitbucket-pipelines.yml' || file === 'bitbucket-pipelines.yaml') return 'bitbucket-pipelines';
    return 'teamcity';
  }

  private extractPipelines(config: CiConfigFile, content: string): CiPipeline[] {
    if (config.provider === 'jenkins') return [this.extractJenkins(config, content)];
    if (config.provider === 'teamcity') return [this.extractTeamCity(config, content)];

    const parsed = this.parseYaml(content);
    if (!parsed || typeof parsed !== 'object') return [];
    const document = parsed as Record<string, any>;

    switch (config.provider) {
      case 'github-actions': return [this.extractGitHubActions(config, content, document)];
      case 'gitlab-ci': return [this.extractGitLab(config, content, document)];
      case 'circleci': return this.extractCircleCi(config, content, document);
      case 'azure-pipelines': return this.extractAzurePipelines(config, content, document);
      case 'travis-ci': return [this.extractTravis(config, content, document)];
      case 'drone': return [this.extractDrone(config, content, document)];
      case 'buildkite': return [this.extractBuildkite(config, content, document)];
      case 'bitbucket-pipelines': return [this.extractBitbucket(config, content, document)];
      default: return [];
    }
  }

  private parseYaml(content: string): unknown {
    return yaml.load(content, { schema: yaml.CORE_SCHEMA });
  }

  private extractGitHubActions(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const pipelineId = this.pipelineId(config.file, document.name || path.basename(config.file, path.extname(config.file)));
    const jobs = Object.entries(asRecord(document.jobs)).map(([jobName, jobValue]) => {
      const job = asRecord(jobValue);
      const environment = typeof job.environment === 'string' ? job.environment : stringValue(asRecord(job.environment).name);
      return this.createJob(config.file, content, pipelineId, jobName, job.name || jobName, {
        line: this.lineForKey(content, jobName),
        needs: toStringArray(job.needs),
        environment,
        matrix: asRecord(job.strategy).matrix,
        steps: toArray(job.steps).map((step, index) => this.githubStep(config.file, content, pipelineId, jobName, step, index)),
        envRefs: [...keysOf(job.env), ...extractEnvRefs(JSON.stringify(job))],
        secretRefs: extractSecretRefs(JSON.stringify(job)),
      });
    });

    return {
      id: pipelineId,
      name: stringValue(document.name) || path.basename(config.file, path.extname(config.file)),
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: this.githubTriggers(document.on ?? document.true, content),
      jobs,
      stages: [],
    };
  }

  private githubStep(file: string, content: string, pipelineId: string, jobName: string, value: unknown, index: number): CiStep {
    const step = asRecord(value);
    const command = stringValue(step.run);
    const action = stringValue(step.uses);
    const name = stringValue(step.name) || action || command?.split(/\r?\n/)[0]?.slice(0, 80) || `step ${index + 1}`;
    return {
      id: this.stepId(pipelineId, jobName, name, index),
      name,
      file,
      line: this.lineForNeedle(content, action || command || name),
      command,
      action,
      deployTarget: deployTargetFromStep(command, action),
      envRefs: [...keysOf(step.env), ...extractEnvRefs(JSON.stringify(step))],
      secretRefs: extractSecretRefs(JSON.stringify(step)),
    };
  }

  private githubTriggers(value: unknown, content: string): CiTrigger[] {
    if (typeof value === 'string') return [pipelineTrigger(value, this.lineForNeedle(content, value))];
    if (Array.isArray(value)) return value.map(event => pipelineTrigger(String(event), this.lineForNeedle(content, String(event))));
    const triggers: CiTrigger[] = [];
    for (const [event, config] of Object.entries(asRecord(value))) {
      if (event === 'schedule') {
        const schedules = Array.isArray(config) ? config : toArray(asRecord(config).include || config);
        for (const item of schedules) {
          const cron = stringValue(asRecord(item).cron) || stringValue(item);
          triggers.push(scheduleTrigger(cron || 'schedule', this.lineForNeedle(content, cron || 'schedule')));
        }
      } else {
        triggers.push(pipelineTrigger(normalizeTriggerName(event), this.lineForKey(content, event), { provider_event: event }));
      }
    }
    return triggers;
  }

  private extractGitLab(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'gitlab-ci');
    const stages: CiStage[] = toStringArray(document.stages).map(stageName => ({
      id: this.stageId(pipelineId, stageName),
      name: stageName,
      file: config.file,
      line: this.lineForNeedle(content, stageName),
      jobs: [],
    }));
    const stageNames = stages.map(stage => stage.name);
    const jobs: CiJob[] = [];

    for (const [jobName, jobValue] of Object.entries(document)) {
      if (RESERVED_GITLAB_KEYS.has(jobName) || jobName.startsWith('.')) continue;
      const job = asRecord(jobValue);
      if (!('script' in job) && !('stage' in job) && !('rules' in job) && !('needs' in job)) continue;
      const stage = stringValue(job.stage) || stageNames[0] || 'test';
      const ciJob = this.createJob(config.file, content, pipelineId, jobName, jobName, {
        line: this.lineForKey(content, jobName),
        stage,
        needs: gitLabNeeds(job.needs),
        environment: environmentName(job.environment),
        rules: this.gitLabRules(job),
        steps: this.commandSteps(config.file, content, pipelineId, jobName, 'script', job.script),
        envRefs: [...keysOf(job.variables), ...extractEnvRefs(JSON.stringify(job))],
        secretRefs: extractSecretRefs(JSON.stringify(job)),
      });
      jobs.push(ciJob);
      const stageNode = stages.find(item => item.name === stage);
      if (stageNode) stageNode.jobs.push(ciJob.id);
    }

    return {
      id: pipelineId,
      name: 'GitLab CI',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: this.gitLabTriggers(document, content),
      jobs,
      stages,
    };
  }

  private gitLabRules(job: Record<string, any>): string[] {
    return [
      ...toArray(job.rules).map(rule => JSON.stringify(rule)),
      ...toStringArray(job.only).map(rule => `only: ${rule}`),
      ...toStringArray(job.except).map(rule => `except: ${rule}`),
    ];
  }

  private gitLabTriggers(document: Record<string, any>, content: string): CiTrigger[] {
    const triggers: CiTrigger[] = [];
    const workflowRules = toArray(asRecord(document.workflow).rules);
    for (const rule of workflowRules) {
      const text = JSON.stringify(rule);
      const schedule = text.match(/schedule/) ? 'schedule' : undefined;
      triggers.push(schedule ? scheduleTrigger(schedule, this.lineForNeedle(content, text)) : pipelineTrigger('workflow-rule', this.lineForNeedle(content, 'rules')));
    }
    if (triggers.length === 0) triggers.push(pipelineTrigger('push', this.lineForNeedle(content, 'workflow')));
    return triggers;
  }

  private extractCircleCi(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline[] {
    const jobsByName = asRecord(document.jobs);
    const workflowEntries: Array<[string, unknown]> = Object.entries(asRecord(document.workflows)).filter(([name]) => name !== 'version');
    const workflowNames: Array<[string, unknown]> = workflowEntries.length ? workflowEntries : [['circleci', { jobs: Object.keys(jobsByName) }]];

    return workflowNames.map(([workflowName, workflowValue]) => {
      const pipelineId = this.pipelineId(config.file, workflowName);
      const workflowJobs = toArray(asRecord(workflowValue).jobs);
      const jobs = workflowJobs.map((item, index) => {
        const jobName = typeof item === 'string' ? item : Object.keys(asRecord(item))[0] || `job-${index + 1}`;
        const invocation = typeof item === 'string' ? {} : asRecord(asRecord(item)[jobName]);
        const definition = asRecord(jobsByName[jobName]);
        return this.createJob(config.file, content, pipelineId, jobName, jobName, {
          line: this.lineForKey(content, jobName),
          requires: toStringArray(invocation.requires),
          matrix: invocation.matrix,
          steps: this.circleSteps(config.file, content, pipelineId, jobName, toArray(definition.steps)),
          envRefs: [...keysOf(definition.environment), ...extractEnvRefs(JSON.stringify(definition))],
          secretRefs: extractSecretRefs(JSON.stringify(definition)),
        });
      });

      return {
        id: pipelineId,
        name: workflowName,
        provider: config.provider,
        file: config.file,
        line: this.lineForKey(content, workflowName),
        triggers: this.circleTriggers(asRecord(workflowValue), content),
        jobs,
        stages: [],
      };
    });
  }

  private circleSteps(file: string, content: string, pipelineId: string, jobName: string, steps: unknown[]): CiStep[] {
    return steps.map((value, index) => {
      const step = typeof value === 'string' ? { name: value } : asRecord(value);
      const run = typeof step.run === 'string' ? step.run : asRecord(step.run).command;
      const action = Object.keys(step).find(key => key !== 'run' && key !== 'checkout' && key !== 'name');
      const command = stringValue(run);
      const name = stringValue(asRecord(step.run).name) || stringValue(step.name) || action || command?.split(/\r?\n/)[0]?.slice(0, 80) || `step ${index + 1}`;
      return {
        id: this.stepId(pipelineId, jobName, name, index),
        name,
        file,
        line: this.lineForNeedle(content, command || action || name),
        command,
        action,
        deployTarget: deployTargetFromStep(command, action),
        envRefs: extractEnvRefs(JSON.stringify(step)),
        secretRefs: extractSecretRefs(JSON.stringify(step)),
      };
    });
  }

  private circleTriggers(workflow: Record<string, any>, content: string): CiTrigger[] {
    const triggers: CiTrigger[] = [];
    for (const schedule of toArray(asRecord(workflow.triggers).schedule ? [asRecord(workflow.triggers).schedule] : asRecord(workflow.triggers).schedules)) {
      const cron = stringValue(asRecord(schedule).cron);
      triggers.push(scheduleTrigger(cron || 'schedule', this.lineForNeedle(content, cron || 'schedule')));
    }
    return triggers;
  }

  private extractJenkins(config: CiConfigFile, content: string): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'jenkins');
    const stages: CiStage[] = [];
    const jobs: CiJob[] = [];
    const stageMatches = [...content.matchAll(/\bstage\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\{/g)];

    stageMatches.forEach((match, index) => {
      const stageName = match[1];
      const line = this.lineForIndex(content, match.index || 0);
      const body = this.sliceBlock(content, (match.index || 0) + match[0].length - 1);
      const job = this.createJob(config.file, content, pipelineId, stageName, stageName, {
        line,
        stage: stageName,
        steps: this.jenkinsSteps(config.file, content, pipelineId, stageName, body, index),
        envRefs: extractEnvRefs(body),
        secretRefs: extractSecretRefs(body),
        metadata: {
          agent: firstMatch(body, /\bagent\s+([A-Za-z0-9_'". -]+)/),
          when: firstMatch(body, /\bwhen\s*\{([\s\S]{0,300}?)\}/),
          post: /\bpost\s*\{/.test(body),
        },
      });
      const stage: CiStage = {
        id: this.stageId(pipelineId, stageName),
        name: stageName,
        file: config.file,
        line,
        jobs: [job.id],
      };
      stages.push(stage);
      jobs.push(job);
    });

    return {
      id: pipelineId,
      name: 'Jenkinsfile',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: this.jenkinsTriggers(content),
      jobs,
      stages,
      metadata: {
        agent: firstMatch(content, /\bagent\s+([A-Za-z0-9_'". -]+)/),
        declarative: /\bpipeline\s*\{/.test(content),
      },
    };
  }

  private jenkinsSteps(file: string, content: string, pipelineId: string, jobName: string, body: string, stageIndex: number): CiStep[] {
    const steps: CiStep[] = [];
    const commandPattern = /\b(sh|bat|powershell|pwsh)\s+(?:script:\s*)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = commandPattern.exec(body))) {
      const command = match[2];
      steps.push({
        id: this.stepId(pipelineId, jobName, command, steps.length),
        name: `${match[1]} ${steps.length + 1}`,
        file,
        line: this.lineForNeedle(content, command),
        command,
        deployTarget: deployTargetFromStep(command),
        envRefs: extractEnvRefs(command),
        secretRefs: extractSecretRefs(command),
        metadata: { shell: match[1], stage_index: stageIndex },
      });
    }
    return steps;
  }

  private jenkinsTriggers(content: string): CiTrigger[] {
    const triggers: CiTrigger[] = [];
    for (const match of content.matchAll(/\bcron\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      triggers.push(scheduleTrigger(match[1], this.lineForIndex(content, match.index || 0)));
    }
    if (/\bpollSCM\s*\(/.test(content)) triggers.push(pipelineTrigger('scm-poll', this.lineForNeedle(content, 'pollSCM')));
    return triggers;
  }

  private extractAzurePipelines(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline[] {
    const pipelineId = this.pipelineId(config.file, 'azure-pipelines');
    const stages: CiStage[] = [];
    const jobs: CiJob[] = [];
    const stageEntries = toArray(document.stages);
    if (stageEntries.length > 0) {
      for (const stageValue of stageEntries) {
        const stage = asRecord(stageValue);
        const stageName = stringValue(stage.stage) || stringValue(stage.name) || `stage-${stages.length + 1}`;
        const stageNode: CiStage = {
          id: this.stageId(pipelineId, stageName),
          name: stageName,
          file: config.file,
          line: this.lineForNeedle(content, stageName),
          jobs: [],
        };
        stages.push(stageNode);
        for (const jobValue of toArray(stage.jobs)) {
          const job = this.azureJob(config.file, content, pipelineId, jobValue, stageName);
          jobs.push(job);
          stageNode.jobs.push(job.id);
        }
      }
    } else {
      for (const jobValue of toArray(document.jobs)) {
        jobs.push(this.azureJob(config.file, content, pipelineId, jobValue));
      }
      if (jobs.length === 0 && Array.isArray(document.steps)) {
        jobs.push(this.createJob(config.file, content, pipelineId, 'azure-pipeline', 'azure-pipeline', {
          line: 1,
          steps: this.azureSteps(config.file, content, pipelineId, 'azure-pipeline', document.steps),
        }));
      }
    }

    return [{
      id: pipelineId,
      name: stringValue(document.name) || 'Azure Pipelines',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: this.azureTriggers(document, content),
      jobs,
      stages,
    }];
  }

  private azureJob(file: string, content: string, pipelineId: string, value: unknown, stage?: string): CiJob {
    const job = asRecord(value);
    const jobName = stringValue(job.job) || stringValue(job.deployment) || stringValue(job.name) || `job-${this.sanitizeId(JSON.stringify(value)).slice(0, 24)}`;
    return this.createJob(file, content, pipelineId, jobName, jobName, {
      line: this.lineForNeedle(content, jobName),
      stage,
      needs: toStringArray(job.dependsOn),
      environment: environmentName(job.environment),
      steps: this.azureSteps(file, content, pipelineId, jobName, toArray(job.steps)),
      envRefs: [...keysOf(job.variables), ...extractEnvRefs(JSON.stringify(job))],
      secretRefs: extractSecretRefs(JSON.stringify(job)),
      metadata: { pool: job.pool },
    });
  }

  private azureSteps(file: string, content: string, pipelineId: string, jobName: string, values: unknown[]): CiStep[] {
    return values.map((value, index) => {
      const step = asRecord(value);
      const command = stringValue(step.script) || stringValue(step.bash) || stringValue(step.pwsh) || stringValue(step.powershell);
      const action = stringValue(step.task) || stringValue(step.template);
      const name = stringValue(step.displayName) || action || command?.split(/\r?\n/)[0]?.slice(0, 80) || `step ${index + 1}`;
      return {
        id: this.stepId(pipelineId, jobName, name, index),
        name,
        file,
        line: this.lineForNeedle(content, action || command || name),
        command,
        action,
        deployTarget: deployTargetFromStep(command, action),
        envRefs: [...keysOf(step.env), ...extractEnvRefs(JSON.stringify(step))],
        secretRefs: extractSecretRefs(JSON.stringify(step)),
      };
    });
  }

  private azureTriggers(document: Record<string, any>, content: string): CiTrigger[] {
    const triggers: CiTrigger[] = [];
    if (document.trigger !== undefined && document.trigger !== 'none') triggers.push(pipelineTrigger('push', this.lineForKey(content, 'trigger')));
    if (document.pr !== undefined && document.pr !== 'none') triggers.push(pipelineTrigger('pull_request', this.lineForKey(content, 'pr')));
    for (const schedule of toArray(document.schedules)) {
      const cron = stringValue(asRecord(schedule).cron);
      triggers.push(scheduleTrigger(cron || 'schedule', this.lineForNeedle(content, cron || 'schedules')));
    }
    return triggers;
  }

  private extractTravis(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'travis-ci');
    const includeJobs = toArray(asRecord(document.jobs).include);
    const jobs = includeJobs.length > 0
      ? includeJobs.map((jobValue, index) => this.travisJob(config.file, content, pipelineId, jobValue, index))
      : [this.travisJob(config.file, content, pipelineId, document, 0)];
    return {
      id: pipelineId,
      name: 'Travis CI',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: this.travisTriggers(document, content),
      jobs,
      stages: [],
    };
  }

  private travisJob(file: string, content: string, pipelineId: string, value: unknown, index: number): CiJob {
    const job = asRecord(value);
    const name = stringValue(job.name) || stringValue(job.stage) || `job-${index + 1}`;
    return this.createJob(file, content, pipelineId, name, name, {
      line: this.lineForNeedle(content, name),
      stage: stringValue(job.stage),
      steps: this.commandSteps(file, content, pipelineId, name, 'script', job.script),
      envRefs: [...toStringArray(job.env), ...extractEnvRefs(JSON.stringify(job))],
      secretRefs: extractSecretRefs(JSON.stringify(job)),
    });
  }

  private travisTriggers(document: Record<string, any>, content: string): CiTrigger[] {
    const triggers: CiTrigger[] = [];
    if (document.branches) triggers.push(pipelineTrigger('branch', this.lineForKey(content, 'branches')));
    if (document.if) triggers.push(pipelineTrigger(String(document.if), this.lineForKey(content, 'if')));
    return triggers;
  }

  private extractDrone(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const name = stringValue(document.name) || 'drone';
    const pipelineId = this.pipelineId(config.file, name);
    const jobs = [{
      id: this.jobId(pipelineId, name),
      name,
      file: config.file,
      line: 1,
      needs: [],
      requires: [],
      rules: [],
      steps: toArray(document.steps).map((step, index) => {
        const record = asRecord(step);
        const command = toStringArray(record.commands).join('\n') || stringValue(record.command);
        const action = stringValue(record.image);
        const stepName = stringValue(record.name) || action || `step ${index + 1}`;
        return {
          id: this.stepId(pipelineId, name, stepName, index),
          name: stepName,
          file: config.file,
          line: this.lineForNeedle(content, stepName),
          command,
          action,
          deployTarget: deployTargetFromStep(command, action),
          envRefs: [...keysOf(record.environment), ...extractEnvRefs(JSON.stringify(record))],
          secretRefs: extractSecretRefs(JSON.stringify(record)),
        };
      }),
      envRefs: extractEnvRefs(JSON.stringify(document)),
      secretRefs: extractSecretRefs(JSON.stringify(document)),
    }];
    return {
      id: pipelineId,
      name,
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: document.trigger ? [pipelineTrigger('trigger', this.lineForKey(content, 'trigger'))] : [],
      jobs,
      stages: [],
    };
  }

  private extractBuildkite(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'buildkite');
    const job = this.createJob(config.file, content, pipelineId, 'buildkite', 'buildkite', {
      line: 1,
      steps: toArray(document.steps).map((step, index) => {
        const record = asRecord(step);
        const command = stringValue(record.command) || toStringArray(record.commands).join('\n');
        const name = stringValue(record.label) || stringValue(record.name) || command?.split(/\r?\n/)[0]?.slice(0, 80) || `step ${index + 1}`;
        return {
          id: this.stepId(pipelineId, 'buildkite', name, index),
          name,
          file: config.file,
          line: this.lineForNeedle(content, name),
          command,
          deployTarget: deployTargetFromStep(command),
          envRefs: [...keysOf(record.env), ...extractEnvRefs(JSON.stringify(record))],
          secretRefs: extractSecretRefs(JSON.stringify(record)),
        };
      }),
      envRefs: extractEnvRefs(JSON.stringify(document)),
      secretRefs: extractSecretRefs(JSON.stringify(document)),
    });
    return {
      id: pipelineId,
      name: 'Buildkite',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: [],
      jobs: [job],
      stages: [],
    };
  }

  private extractBitbucket(config: CiConfigFile, content: string, document: Record<string, any>): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'bitbucket-pipelines');
    const jobs: CiJob[] = [];
    for (const [groupName, groupValue] of Object.entries(asRecord(document.pipelines))) {
      const group = Array.isArray(groupValue) ? groupValue : Object.values(asRecord(groupValue)).flatMap(value => toArray(value));
      group.forEach((item, index) => {
        const step = asRecord(asRecord(item).step || item);
        const jobName = `${groupName}-${index + 1}`;
        jobs.push(this.createJob(config.file, content, pipelineId, jobName, stringValue(step.name) || jobName, {
          line: this.lineForNeedle(content, stringValue(step.name) || groupName),
          steps: this.commandSteps(config.file, content, pipelineId, jobName, 'script', step.script),
          envRefs: extractEnvRefs(JSON.stringify(step)),
          secretRefs: extractSecretRefs(JSON.stringify(step)),
        }));
      });
    }
    return {
      id: pipelineId,
      name: 'Bitbucket Pipelines',
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: Object.keys(asRecord(document.pipelines)).map(name => pipelineTrigger(name, this.lineForKey(content, name))),
      jobs,
      stages: [],
    };
  }

  private extractTeamCity(config: CiConfigFile, content: string): CiPipeline {
    const pipelineId = this.pipelineId(config.file, 'teamcity');
    return {
      id: pipelineId,
      name: path.basename(config.file),
      provider: config.provider,
      file: config.file,
      line: 1,
      triggers: [],
      jobs: [],
      stages: [],
      metadata: {
        depth_follow_up: 'TeamCity Kotlin DSL detected; full Kotlin DSL model parsing is not implemented by this CI analyzer.',
        build_type_count: [...content.matchAll(/\b(BuildType|buildType)\b/g)].length,
      },
    };
  }

  private createJob(
    file: string,
    content: string,
    pipelineId: string,
    key: string,
    name: string,
    options: Partial<CiJob>
  ): CiJob {
    return {
      id: this.jobId(pipelineId, key),
      name,
      file,
      line: options.line || this.lineForNeedle(content, key),
      stage: options.stage,
      needs: options.needs || [],
      requires: options.requires || [],
      environment: options.environment,
      matrix: options.matrix,
      rules: options.rules || [],
      steps: options.steps || [],
      envRefs: options.envRefs || [],
      secretRefs: options.secretRefs || [],
      metadata: options.metadata,
    };
  }

  private commandSteps(file: string, content: string, pipelineId: string, jobName: string, label: string, value: unknown): CiStep[] {
    const commands = toStringArray(value);
    return commands.map((command, index) => ({
      id: this.stepId(pipelineId, jobName, `${label}-${index + 1}`, index),
      name: command.split(/\r?\n/)[0].slice(0, 80) || `${label} ${index + 1}`,
      file,
      line: this.lineForNeedle(content, command),
      command,
      deployTarget: deployTargetFromStep(command),
      envRefs: extractEnvRefs(command),
      secretRefs: extractSecretRefs(command),
    }));
  }

  private emitPipeline(
    pipeline: CiPipeline,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    nodes.push(this.createNodeBuilder(pipeline.id, pipeline.name, 'ci_pipeline')
      .withLevel(2, this.getLevelName(2))
      .withCategory('pipeline', ['ci', pipeline.provider])
      .withSource({ file: pipeline.file, line: pipeline.line })
      .withMetadata({
        framework: 'ci-pipeline',
        attributes: {
          provider: pipeline.provider,
          config_file: pipeline.file,
          triggers: pipeline.triggers.map(trigger => trigger.event),
          ...pipeline.metadata,
        },
      })
      .build());

    pipeline.triggers.forEach((trigger, index) => {
      entryPoints.push(this.createEntryPoint(
        `entry:${pipeline.id}:${this.sanitizeId(trigger.event)}:${index}`,
        pipeline.id,
        trigger.type,
        `${pipeline.name} ${trigger.event}`,
        `CI pipeline trigger ${trigger.event} for ${pipeline.name}.`,
        trigger.type === 'schedule'
          ? { schedule: trigger.schedule || trigger.event }
          : { event: trigger.event },
        undefined,
        { provider: pipeline.provider, file: pipeline.file, line: trigger.line, ...trigger.metadata },
        { node_id: pipeline.id, method_name: trigger.event, file: pipeline.file, line: trigger.line }
      ));
    });

    for (const stage of pipeline.stages) {
      nodes.push(this.createNodeBuilder(stage.id, stage.name, 'ci_stage')
        .withLevel(3, this.getLevelName(3))
        .withCategory('pipeline-stage', ['ci', pipeline.provider])
        .withSource({ file: stage.file, line: stage.line })
        .withMetadata({ framework: 'ci-pipeline', attributes: { provider: pipeline.provider, jobs: stage.jobs } })
        .build());
      edges.push(this.createEdge(this.generateEdgeId(pipeline.id, stage.id, 'contains'), pipeline.id, stage.id, 'contains', 'structural'));
    }

    for (let i = 1; i < pipeline.stages.length; i++) {
      edges.push(this.createEdge(
        this.generateEdgeId(pipeline.stages[i].id, pipeline.stages[i - 1].id, 'depends_on'),
        pipeline.stages[i].id,
        pipeline.stages[i - 1].id,
        'depends_on',
        'execution',
        { reason: 'stage_order' }
      ));
    }

    const jobsByName = new Map<string, CiJob>();
    const deployTargetIds = new Set<string>();
    for (const job of pipeline.jobs) {
      jobsByName.set(job.name, job);
      jobsByName.set(job.id.split(':').pop() || job.name, job);
      nodes.push(this.createNodeBuilder(job.id, job.name, 'ci_job')
        .withLevel(3, this.getLevelName(3))
        .withCategory('pipeline-job', ['ci', pipeline.provider])
        .withSource({ file: job.file, line: job.line })
        .withMetadata({
          framework: 'ci-pipeline',
          attributes: {
            provider: pipeline.provider,
            stage: job.stage,
            needs: job.needs,
            requires: job.requires,
            environment: job.environment,
            matrix: job.matrix,
            rules: job.rules,
            env_refs: dedupe(job.envRefs),
            secret_refs: dedupe(job.secretRefs),
            ...job.metadata,
          },
        })
        .build());
      edges.push(this.createEdge(this.generateEdgeId(pipeline.id, job.id, 'contains'), pipeline.id, job.id, 'contains', 'structural'));
      if (job.stage) {
        const stageId = this.stageId(pipeline.id, job.stage);
        edges.push(this.createEdge(this.generateEdgeId(stageId, job.id, 'contains'), stageId, job.id, 'contains', 'structural'));
      }
      this.emitJobSteps(pipeline, job, nodes, edges, exitPoints, deployTargetIds);
    }

    for (const job of pipeline.jobs) {
      for (const dependency of [...job.needs, ...job.requires]) {
        const target = jobsByName.get(dependency) || jobsByName.get(this.jobId(pipeline.id, dependency).split(':').pop() || dependency);
        if (!target) continue;
        edges.push(this.createEdge(
          this.generateEdgeId(job.id, target.id, 'depends_on'),
          job.id,
          target.id,
          'depends_on',
          'execution',
          { dependency, evidence: 'needs/requires' }
        ));
      }
    }
  }

  private emitJobSteps(
    pipeline: CiPipeline,
    job: CiJob,
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[],
    deployTargetIds: Set<string>
  ): void {
    for (const step of job.steps) {
      nodes.push(this.createNodeBuilder(step.id, step.name, 'ci_step')
        .withLevel(4, this.getLevelName(4))
        .withCategory('pipeline-step', ['ci', pipeline.provider])
        .withSource({ file: step.file, line: step.line })
        .withMetadata({
          framework: 'ci-pipeline',
          attributes: {
            provider: pipeline.provider,
            command: step.command,
            action: step.action,
            deploy_target: step.deployTarget,
            env_refs: dedupe(step.envRefs),
            secret_refs: dedupe(step.secretRefs),
            ...step.metadata,
          },
        })
        .build());
      edges.push(this.createEdge(this.generateEdgeId(job.id, step.id, 'contains'), job.id, step.id, 'contains', 'structural'));

      if (step.deployTarget || job.environment) {
        const targetName = step.deployTarget || job.environment!;
        const targetId = `deploy_target:${this.sanitizeId(pipeline.file)}:${this.sanitizeId(targetName)}`;
        if (!deployTargetIds.has(targetId)) {
          nodes.push(this.createNodeBuilder(targetId, targetName, 'deploy_target')
            .withLevel(2, 'deployment target')
            .withCategory('deployment-target', ['ci', pipeline.provider])
            .withSource({ file: step.file, line: step.line })
            .withMetadata({ framework: 'ci-pipeline', attributes: { provider: pipeline.provider, environment: job.environment, target: step.deployTarget } })
            .build());
          deployTargetIds.add(targetId);
        }
        edges.push(this.createEdge(this.generateEdgeId(step.id, targetId, 'deploys_to'), step.id, targetId, 'deploys_to', 'deployment'));
        exitPoints.push(this.createExitPoint(
          `exit:${step.id}:deploy`,
          step.id,
          'sdk',
          `${step.name} deploys to ${targetName}`,
          `CI step deploys to ${targetName}.`,



          { service_id: targetName, resource: targetName, sdk: targetName },
          { action: 'deploy', async: true },
          { provider: pipeline.provider, file: step.file, line: step.line, command: step.command, action: step.action }
        ));
      }
    }
  }

  private pipelineId(file: string, name: string): string {
    return `ci_pipeline:${this.sanitizeId(file)}:${this.sanitizeId(name)}`;
  }

  private stageId(pipelineId: string, name: string): string {
    return `${pipelineId}:stage:${this.sanitizeId(name)}`;
  }

  private jobId(pipelineId: string, name: string): string {
    return `${pipelineId}:job:${this.sanitizeId(name)}`;
  }

  private stepId(pipelineId: string, jobName: string, name: string, index: number): string {
    return `${pipelineId}:job:${this.sanitizeId(jobName)}:step:${index}:${this.sanitizeId(name).slice(0, 48)}`;
  }

  private lineForKey(content: string, key: string): number {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.lineForRegex(content, new RegExp(`^\\s*['"]?${escaped}['"]?\\s*:`, 'm'));
  }

  private lineForNeedle(content: string, needle: string | undefined): number {
    if (!needle) return 1;
    const index = content.indexOf(needle);
    return index >= 0 ? this.lineForIndex(content, index) : 1;
  }

  private lineForRegex(content: string, regex: RegExp): number {
    const match = regex.exec(content);
    return match?.index !== undefined ? this.lineForIndex(content, match.index) : 1;
  }

  private lineForIndex(content: string, index: number): number {
    return content.slice(0, index).split(/\r?\n/).length;
  }

  private sliceBlock(content: string, openBraceIndex: number): string {
    let depth = 0;
    for (let i = openBraceIndex; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') {
        depth--;
        if (depth === 0) return content.slice(openBraceIndex + 1, i);
      }
    }
    return content.slice(openBraceIndex + 1);
  }
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(item => toStringArray(item));
  if (value === undefined || value === null) return [];
  return [String(value)].filter(Boolean);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function keysOf(value: unknown): string[] {
  return Object.keys(asRecord(value));
}

function environmentName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return stringValue(asRecord(value).name) || stringValue(asRecord(value).environment);
}

function gitLabNeeds(value: unknown): string[] {
  return toArray(value).map(item => typeof item === 'string' ? item : stringValue(asRecord(item).job)).filter((item): item is string => Boolean(item));
}

function normalizeTriggerName(value: string): string {
  if (value === 'pull_request') return 'pull_request';
  if (value === 'workflow_dispatch') return 'manual';
  if (value === 'release') return 'release';
  if (value === 'push') return 'push';
  return value;
}

function pipelineTrigger(event: string, line?: number, metadata?: Record<string, any>): CiTrigger {
  return { type: 'pipeline', event, line, metadata };
}

function scheduleTrigger(schedule: string, line?: number): CiTrigger {
  return { type: 'schedule', event: 'schedule', schedule, line };
}

function deployTargetFromStep(command?: string, action?: string): string | undefined {
  const text = `${command || ''}\n${action || ''}`;
  if (!DEPLOY_MARKER.test(text)) return undefined;
  const envMatch = text.match(/(?:^|\s)(?:environment|env|namespace|--namespace|-n)\s*[=: ]\s*([A-Za-z0-9_.-]+)/i);
  if (envMatch) return envMatch[1];
  const platformMatch = text.match(/\b(kubectl|helm|serverless|terraform|vercel|netlify|flyctl|npm|cargo|docker|gh)\b/i);
  return platformMatch ? platformMatch[1].toLowerCase() : 'deployment';
}

function extractEnvRefs(value: string): string[] {
  const refs = new Set<string>();
  for (const match of value.matchAll(/\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) refs.add(match[1]);
  for (const match of value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) refs.add(match[1]);
  return Array.from(refs);
}

function extractSecretRefs(value: string): string[] {
  const refs = new Set<string>();
  for (const match of value.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) refs.add(match[1]);
  for (const match of value.matchAll(/\bsecret[s]?[._-]([A-Za-z_][A-Za-z0-9_]*)/gi)) refs.add(match[1]);
  return Array.from(refs);
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function firstMatch(content: string, pattern: RegExp): string | undefined {
  return pattern.exec(content)?.[1]?.trim();
}
