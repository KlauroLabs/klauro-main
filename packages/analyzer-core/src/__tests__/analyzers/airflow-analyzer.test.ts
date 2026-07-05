jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AirflowAnalyzer } from '../../analyzer/frameworks/dataml/airflow-analyzer';

const DAG_FIXTURE = [
  'from airflow import DAG',
  'from airflow.operators.python import PythonOperator',
  'from datetime import datetime',
  '',
  'def extract():',
  '    pass',
  '',
  'def transform():',
  '    pass',
  '',
  'def load():',
  '    pass',
  '',
  'with DAG("etl_pipeline", schedule_interval="@daily", start_date=datetime(2024, 1, 1)) as dag:',
  '    extract_task = PythonOperator(task_id="extract_task", python_callable=extract)',
  '    transform_task = PythonOperator(task_id="transform_task", python_callable=transform)',
  '    load_task = PythonOperator(task_id="load_task", python_callable=load)',
  '',
  '    extract_task >> transform_task >> load_task',
  ''
].join('\n');

async function withTempDir(files: Record<string, string>, run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'airflow-test-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.ensureDir(path.dirname(full));
      await fs.writeFile(full, content);
    }
    await run(dir);
  } finally {
    await fs.remove(dir);
  }
}

describe('AirflowAnalyzer', () => {
  it('detects an Airflow DAG file', async () => {
    await withTempDir({ 'dags/etl.py': DAG_FIXTURE }, async (dir) => {
      const analyzer = new AirflowAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(true);
    });
  });

  it('does not detect a project with no Airflow usage', async () => {
    await withTempDir({ 'app.py': 'print("hello")\n' }, async (dir) => {
      const analyzer = new AirflowAnalyzer();
      expect(await analyzer.canAnalyze(dir)).toBe(false);
    });
  });

  it('extracts the DAG, its three tasks, and the >> dependency chain', async () => {
    await withTempDir({ 'dags/etl.py': DAG_FIXTURE }, async (dir) => {
      const analyzer = new AirflowAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: dir } as any);

      const dagNodes = contribution.nodes!.filter(n => n.type === 'pipeline');
      expect(dagNodes).toHaveLength(1);
      expect(dagNodes[0].name).toBe('etl_pipeline');

      const taskNodes = contribution.nodes!.filter(n => n.type === 'task');
      expect(taskNodes.map(n => n.name).sort()).toEqual(['extract_task', 'load_task', 'transform_task']);

      const taskEntryPoints = contribution.entry_points!.filter(ep => ep.type === 'task');
      expect(taskEntryPoints).toHaveLength(3);

      const pipelineEntryPoints = contribution.entry_points!.filter(ep => ep.type === 'pipeline');
      expect(pipelineEntryPoints).toHaveLength(1);
      expect(pipelineEntryPoints[0].trigger?.schedule).toBe('@daily');

      const precedesEdges = contribution.edges!.filter(e => e.type === 'precedes');
      expect(precedesEdges).toHaveLength(2); // extract->transform, transform->load

      const containsEdges = contribution.edges!.filter(e => e.type === 'contains');
      expect(containsEdges).toHaveLength(3); // dag contains each task
    });
  });

  it('extracts dependencies expressed via set_downstream/set_upstream', () => {
    const analyzer = new AirflowAnalyzer();
    const content = [
      'a = PythonOperator(task_id="a")',
      'b = PythonOperator(task_id="b")',
      'a.set_downstream(b)'
    ].join('\n');
    const deps = analyzer.extractDependencies(content, 'dag.py');
    expect(deps).toEqual([{ file: 'dag.py', line: 3, upstream: ['a'], downstream: ['b'] }]);
  });

  it('extracts TaskFlow @task-decorated functions', () => {
    const analyzer = new AirflowAnalyzer();
    const content = [
      '@task',
      'def my_taskflow_task():',
      '    pass'
    ].join('\n');
    const tasks = analyzer.extractTasks(content, 'dag.py', []);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe('my_taskflow_task');
    expect(tasks[0].operator).toBe('@task');
  });
});
