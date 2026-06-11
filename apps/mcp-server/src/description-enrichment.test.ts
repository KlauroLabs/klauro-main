import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { generateElementDescription, getElementDescription } from './description-enrichment';
import { saveAnalysis } from './storage';

test('manual element descriptions are stored and invalidated when source changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-project-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousLocal = process.env.AI_LOCAL_ENABLED;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.AI_LOCAL_ENABLED = 'true';

  const sourceFile = path.join(root, 'src', 'drivers.service.ts');
  await fs.ensureDir(path.dirname(sourceFile));
  await fs.writeFile(sourceFile, 'export class DriversService { listDrivers() { return []; } }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-test',
    system: { id: 'system-test', name: 'fleet-api', type: 'service', root_path: root },
    nodes: [{
      id: 'node-drivers-service',
      name: 'DriversService',
      type: 'service',
      source: { file: 'src/drivers.service.ts', line: 1 },
      metadata: {},
    }],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    enhanced_system_purpose: {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'fleet-management',
      core_concepts: ['driver', 'fleet'],
      inferred_description: 'A fleet management backend.',
      supporting_workflow_ids: [],
    },
  };

  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () =>
    'DriversService coordinates driver records for fleet operations and provides the service boundary used by driver workflows.';

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'DriversService',
      targetKind: 'service',
    });

    assert.equal(generated.status, 'success');
    assert.match(generated.description, /driver records/i);

    const stored = await getElementDescription({
      projectPath: root,
      target: 'node-drivers-service',
      targetKind: 'service',
    });
    assert.equal(stored.status, 'valid');

    await new Promise(resolve => setTimeout(resolve, 5));
    await fs.writeFile(sourceFile, 'export class DriversService { listDrivers() { return [1]; } }\n');

    const invalidated = await getElementDescription({
      projectPath: root,
      target: 'node-drivers-service',
      targetKind: 'service',
    });
    assert.equal(invalidated.status, 'invalidated');
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
    else process.env.AI_LOCAL_ENABLED = previousLocal;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions reject unsupported marketing claims', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-reject-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousLocal = process.env.AI_LOCAL_ENABLED;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.AI_LOCAL_ENABLED = 'true';

  const sourceFile = path.join(root, 'src', 'drivers.service.ts');
  await fs.ensureDir(path.dirname(sourceFile));
  await fs.writeFile(sourceFile, 'export class DriversService { listDrivers() { return []; } }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-reject-test',
    system: { id: 'system-test', name: 'fleet-api', type: 'service', root_path: root },
    nodes: [{
      id: 'node-drivers-service',
      name: 'DriversService',
      type: 'service',
      source: { file: 'src/drivers.service.ts', line: 1 },
      metadata: {},
    }],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  };

  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () =>
    'DriversService improves operational efficiency and ensures compliant fleet workflows with a user-friendly driver management experience.';

  try {
    await saveAnalysis(root, cas);
    await assert.rejects(
      () => generateElementDescription({
        projectPath: root,
        target: 'DriversService',
        targetKind: 'service',
      }),
      /low-quality or ungrounded description/,
    );
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
    else process.env.AI_LOCAL_ENABLED = previousLocal;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions retry once and store the repaired grounded answer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-repair-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousLocal = process.env.AI_LOCAL_ENABLED;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.AI_LOCAL_ENABLED = 'true';

  const sourceFile = path.join(root, 'src', 'drivers.service.ts');
  await fs.ensureDir(path.dirname(sourceFile));
  await fs.writeFile(sourceFile, 'export class DriversService { listDrivers() { return []; } }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-repair-test',
    system: { id: 'system-test', name: 'fleet-api', type: 'service', root_path: root },
    nodes: [{
      id: 'node-drivers-service',
      name: 'DriversService',
      type: 'service',
      source: { file: 'src/drivers.service.ts', line: 1 },
      metadata: {},
    }],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    enhanced_system_purpose: {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'fleet-management',
      core_concepts: ['driver'],
      inferred_description: 'A backend that includes driver records.',
      supporting_workflow_ids: [],
    },
  };

  let calls = 0;
  let sawSourceExcerpt = false;
  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async (context: any) => {
    calls += 1;
    sawSourceExcerpt ||= context.additionalContext?.target?.source_excerpt?.includes('listDrivers') === true;
    if (calls === 1) {
      return 'DriversService improves operational efficiency with a user-friendly, scalable driver management experience.';
    }
    return 'DriversService provides the service boundary for calling `listDrivers` in the fleet-api backend.';
  };

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'DriversService',
      targetKind: 'service',
    });

    assert.equal(calls, 2);
    assert.equal(sawSourceExcerpt, true);
    assert.equal(generated.status, 'success');
    assert.equal(generated.description, 'DriversService provides the service boundary for calling listDrivers in the fleet-api backend.');

    const stored = await getElementDescription({
      projectPath: root,
      target: 'node-drivers-service',
      targetKind: 'service',
    });
    assert.equal(stored.status, 'valid');
    assert.equal(stored.description, generated.description);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
    else process.env.AI_LOCAL_ENABLED = previousLocal;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions reject generic filler word salad that the validator previously admitted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-filler-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousLocal = process.env.AI_LOCAL_ENABLED;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.AI_LOCAL_ENABLED = 'true';

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-filler-test',
    system: { id: 'system-test', name: 'gateway', type: 'service', root_path: root },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_zerac',
      name: 'Zerac Management',
      description: 'Zerac Management covers process paths; spans zerac.',
      category: 'core',
      criticality: 'medium',
      criticality_factors: [],
      operations: [],
      related_entities: [],
      related_domains: ['zerac'],
    }] as any,
  };

  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () =>
    'Zerac Management coordinates the integration of zerac-related components and protocol agents to ensure secure communication. It facilitates the interaction between zerac services and protocol modules to support secure data transmission and session management.';

  try {
    await saveAnalysis(root, cas);
    await assert.rejects(
      () => generateElementDescription({
        projectPath: root,
        target: 'Zerac Management',
        targetKind: 'capability',
      }),
      /low-quality or ungrounded description/,
    );
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
    else process.env.AI_LOCAL_ENABLED = previousLocal;
    await fs.remove(root);
    await fs.remove(storage);
  }
});
