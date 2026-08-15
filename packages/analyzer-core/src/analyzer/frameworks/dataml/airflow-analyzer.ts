import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint
} from '../../../types/cas.types';
import { AnalyzerError } from '../../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';






interface AirflowTask {
  taskId: string;
  varName: string;
  operator: string;
  file: string;
  line: number;
  dagVar: string;
}

interface AirflowDag {
  dagVar: string;
  dagId: string;
  file: string;
  line: number;
  schedule?: string;
}


interface AirflowDependency {
  file: string;
  line: number;
  upstream: string[];
  downstream: string[];
}

const OPERATOR_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_.]*(?:Operator|Sensor))\s*\(/;
const TASKFLOW_DECORATOR_PATTERN = /^\s*@task(?:\.\w+)?\s*(?:\([^)]*\))?\s*$/;
const DEF_PATTERN = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const DAG_DECORATOR_PATTERN = /^\s*@dag\s*(?:\(([^)]*)\))?\s*$/;
const DAG_WITH_PATTERN = /^\s*with\s+DAG\s*\(\s*(?:['"]([^'"]*)['"])?/;
const DAG_CTOR_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*DAG\s*\(\s*(?:['"]([^'"]*)['"])?/;
const TASK_ID_KW_PATTERN = /task_id\s*=\s*['"]([^'"]+)['"]/;
const SCHEDULE_KW_PATTERN = /schedule(?:_interval)?\s*=\s*['"]?([^,'")\s]+)['"]?/;

export class AirflowAnalyzer extends BaseAnalyzer {
  constructor() {
    super('airflow', 'Apache Airflow Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const requirementsPath = path.join(projectPath, 'requirements.txt');
      if (await fs.pathExists(requirementsPath)) {
        const requirements = await fs.readFile(requirementsPath, 'utf-8');
        if (/apache-airflow/i.test(requirements)) return true;
      }

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath } as AnalysisContext), '**/dags_bak/**'],
        nodir: true
      });

      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (this.looksLikeAirflow(content)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private looksLikeAirflow(content: string): boolean {
    return /from\s+airflow\b|import\s+airflow\b/.test(content) &&
      (/\bDAG\s*\(/.test(content) || /@dag\b/.test(content) || /@task\b/.test(content));
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];

    try {
      const pyFiles = await glob(['**/*.py'], {
        cwd: context.projectPath,
        ignore: this.getIgnorePatterns(context),
        nodir: true
      });

      const airflowFiles: string[] = [];
      for (const file of pyFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        if (this.looksLikeAirflow(content)) airflowFiles.push(file);
      }

      if (airflowFiles.length === 0) {
        return this.createContribution(nodes, edges, entryPoints, exitPoints, {
          framework: 'airflow',
          dagsFound: 0
        });
      }

      let dagsFound = 0;
      let tasksFound = 0;
      let dependenciesFound = 0;

      for (const file of airflowFiles) {
        const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
        const dags = this.extractDags(content, file);
        const tasks = this.extractTasks(content, file, dags);
        const deps = this.extractDependencies(content, file);

        dagsFound += dags.length;
        tasksFound += tasks.length;
        dependenciesFound += deps.length;

        const taskNodeIdByVar = new Map<string, string>();

        for (const dag of dags) {
          const dagId = `airflow_dag_${this.sanitizeId(dag.dagId)}_${this.sanitizeId(file)}`;
          const dagNode = this.createNodeBuilder(dagId, dag.dagId, 'pipeline')
            .withLevel(2, 'architectural')
            .withCategory('pipeline', ['airflow', 'dag', 'orchestration'])
            .withSource({ file: dag.file, line: dag.line, end_line: dag.line })
            .withDescription(`Airflow DAG: ${dag.dagId}`)
            .withMetadata({ framework: 'airflow', attributes: { schedule: dag.schedule || null } })
            .build();
          nodes.push(dagNode);

          entryPoints.push(this.createEntryPoint(
            `entry_${dagId}`,
            dagId,
            'pipeline',
            dag.dagId,
            `Airflow DAG entry point: ${dag.dagId}`,
            { schedule: dag.schedule },
            undefined,
            { framework: 'airflow', dagId: dag.dagId, schedule: dag.schedule || null },
            { node_id: dagId, method_name: dag.dagId, file: dag.file, line: dag.line }
          ));
        }

        for (const task of tasks) {
          const taskNodeId = `airflow_task_${this.sanitizeId(task.taskId)}_${this.sanitizeId(file)}_${task.line}`;
          taskNodeIdByVar.set(task.varName, taskNodeId);

          const taskNode = this.createNodeBuilder(taskNodeId, task.taskId, 'task')
            .withLevel(3, 'code')
            .withCategory('task', ['airflow', 'operator', task.operator])
            .withSource({ file: task.file, line: task.line, end_line: task.line })
            .withDescription(`Airflow task "${task.taskId}" (${task.operator})`)
            .withMetadata({ framework: 'airflow', attributes: { operator: task.operator, dagVar: task.dagVar } })
            .build();
          nodes.push(taskNode);

          const owningDag = dags.find(d => d.dagVar === task.dagVar);
          if (owningDag) {
            const dagId = `airflow_dag_${this.sanitizeId(owningDag.dagId)}_${this.sanitizeId(file)}`;
            edges.push(this.createEdge(`${dagId}_contains_${taskNodeId}`, dagId, taskNodeId, 'contains'));
          }

          entryPoints.push(this.createEntryPoint(
            `entry_${taskNodeId}`,
            taskNodeId,
            'task',
            task.taskId,
            `Airflow task entry point: ${task.taskId} (${task.operator})`,
            undefined,
            undefined,
            { framework: 'airflow', operator: task.operator, taskId: task.taskId },
            { node_id: taskNodeId, method_name: task.taskId, file: task.file, line: task.line }
          ));
        }




        for (const dep of deps) {
          for (const up of dep.upstream) {
            for (const down of dep.downstream) {
              const upId = taskNodeIdByVar.get(up) || `airflow_task_ref_${this.sanitizeId(up)}`;
              const downId = taskNodeIdByVar.get(down) || `airflow_task_ref_${this.sanitizeId(down)}`;
              edges.push(this.createEdge(
                `${upId}_precedes_${downId}_${dep.line}`,
                upId,
                downId,
                'precedes',
                'dag-dependency',
                { framework: 'airflow', file: dep.file, line: dep.line }
              ));
            }
          }
        }
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework: 'airflow',
        dagsFound,
        tasksFound,
        dependenciesFound
      });
    } catch (error) {
      throw new AnalyzerError(`Airflow analysis failed: ${(error as Error).message}`, 'AIRFLOW_ANALYSIS_ERROR');
    }
  }


  extractDags(content: string, file: string): AirflowDag[] {
    const dags: AirflowDag[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const withMatch = line.match(DAG_WITH_PATTERN);
      if (withMatch) {
        const asMatch = line.match(/as\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        const dagId = withMatch[1] || this.extractKwString(line, 'dag_id') || `dag_${i}`;
        dags.push({
          dagVar: asMatch ? asMatch[1] : 'dag',
          dagId,
          file,
          line: i + 1,
          schedule: this.matchGroup(line, SCHEDULE_KW_PATTERN)
        });
        continue;
      }

      const ctorMatch = line.match(DAG_CTOR_PATTERN);
      if (ctorMatch) {
        const dagId = ctorMatch[2] || this.extractKwString(line, 'dag_id') || ctorMatch[1];
        dags.push({
          dagVar: ctorMatch[1],
          dagId,
          file,
          line: i + 1,
          schedule: this.matchGroup(line, SCHEDULE_KW_PATTERN)
        });
        continue;
      }

      const dagDecoratorMatch = line.match(DAG_DECORATOR_PATTERN);
      if (dagDecoratorMatch) {

        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const defMatch = j < lines.length ? lines[j].match(DEF_PATTERN) : null;
        if (defMatch) {
          dags.push({
            dagVar: defMatch[1],
            dagId: defMatch[1],
            file,
            line: i + 1,
            schedule: this.matchGroup(dagDecoratorMatch[1] || '', SCHEDULE_KW_PATTERN)
          });
        }
      }
    }

    return dags;
  }


  extractTasks(content: string, file: string, dags: AirflowDag[]): AirflowTask[] {
    const tasks: AirflowTask[] = [];
    const lines = content.split('\n');
    const defaultDagVar = dags.length > 0 ? dags[0].dagVar : 'dag';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const operatorMatch = line.match(OPERATOR_PATTERN);
      if (operatorMatch) {
        const varName = operatorMatch[1];
        const operator = operatorMatch[2];

        let callText = line;
        let j = i;
        while (!/task_id\s*=/.test(callText) && j < lines.length - 1 && !/\)\s*$/.test(lines[j].trim())) {
          j++;
          callText += '\n' + lines[j];
          if (j - i > 15) break;
        }
        const taskId = this.matchGroup(callText, TASK_ID_KW_PATTERN) || varName;
        tasks.push({ taskId, varName, operator, file, line: i + 1, dagVar: defaultDagVar });
        continue;
      }

      const taskFlowMatch = line.match(TASKFLOW_DECORATOR_PATTERN);
      if (taskFlowMatch) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const defMatch = j < lines.length ? lines[j].match(DEF_PATTERN) : null;
        if (defMatch) {
          tasks.push({
            taskId: defMatch[1],
            varName: defMatch[1],
            operator: '@task',
            file,
            line: i + 1,
            dagVar: defaultDagVar
          });
        }
      }
    }

    return tasks;
  }


  extractDependencies(content: string, file: string): AirflowDependency[] {
    const deps: AirflowDependency[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      if (/>>|<</.test(trimmed) && /^[\w.\[\], "'<>]+$/.test(trimmed)) {



        const parts = trimmed.split(/\s*(>>|<<)\s*/).filter(p => p !== '');
        if (parts.length >= 3 && parts.length % 2 === 1) {
          for (let p = 0; p < parts.length - 2; p += 2) {
            const leftGroup = this.parseTaskList(parts[p]);
            const operator = parts[p + 1];
            const rightGroup = this.parseTaskList(parts[p + 2]);
            const [upstream, downstream] = operator === '>>' ? [leftGroup, rightGroup] : [rightGroup, leftGroup];
            if (upstream.length > 0 && downstream.length > 0) {
              deps.push({ file, line: i + 1, upstream, downstream });
            }
          }
          continue;
        }
      }

      const downstreamCallMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\.set_downstream\(([^)]+)\)/);
      if (downstreamCallMatch) {
        deps.push({
          file,
          line: i + 1,
          upstream: [downstreamCallMatch[1]],
          downstream: this.parseTaskList(downstreamCallMatch[2])
        });
        continue;
      }

      const upstreamCallMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\.set_upstream\(([^)]+)\)/);
      if (upstreamCallMatch) {
        deps.push({
          file,
          line: i + 1,
          upstream: this.parseTaskList(upstreamCallMatch[2]),
          downstream: [upstreamCallMatch[1]]
        });
      }
    }

    return deps;
  }

  private parseTaskList(text: string): string[] {
    return text
      .replace(/[\[\]"']/g, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  private matchGroup(text: string, pattern: RegExp): string | undefined {
    const m = text.match(pattern);
    return m ? m[1] : undefined;
  }

  private extractKwString(line: string, kw: string): string | undefined {
    const m = line.match(new RegExp(`${kw}\\s*=\\s*['"]([^'"]+)['"]`));
    return m ? m[1] : undefined;
  }

  protected getCapabilities(): string[] {
    return ['airflow-analysis', 'dag-extraction', 'task-extraction', 'dependency-graph'];
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
}
