import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { generateElementDescription, getElementDescription, validateDescription } from './description-enrichment';
import { saveAnalysis } from './storage';

test('manual element descriptions are stored and invalidated when source changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-project-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

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
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions reject unsupported marketing claims', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-reject-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

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
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions retry once and store the repaired grounded answer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-repair-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

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
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions reject generic filler word salad that the validator previously admitted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-filler-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

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
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual element descriptions reject file coordination summaries from local models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-file-restatement-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-file-restatement-test',
    system: { id: 'system-test', name: 'klauro', type: 'service', root_path: root },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_contexts',
      name: 'Agent Contexts',
      description: 'Agent Contexts turns graph matches and tests into compact coding context for agents.',
      category: 'core',
      criticality: 'critical',
      criticality_factors: [],
      operations: [],
      related_entities: [],
      related_domains: ['agent'],
    }] as any,
  };

  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () =>
    'Agent Contexts manages the creation and coordination of files related to agent adoption and measurement, including files like agent-adoption.ts.';

  try {
    await saveAnalysis(root, cas);
    await assert.rejects(
      () => generateElementDescription({
        projectPath: root,
        target: 'Agent Contexts',
        targetKind: 'capability',
      }),
      /low-quality or ungrounded description/,
    );
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual capability descriptions reject implementation-function summaries from local models', async () => {
  const result = validateDescription(
    'Agent Contexts organizes and executes specific functions like parseArgs, formatTable, and renderRow to process and structure data.',
    { kind: 'capability', name: 'Agent Contexts', target: { related_domains: ['agent'] } },
    groundingCas({ primary_domain: 'agent-development', core_concepts: ['agent', 'agent context'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'implementation-function-restatement');
});

test('manual capability descriptions reject implementation-surface summaries from local models', async () => {
  const result = validateDescription(
    'Maintenance Issue Management helps engineers create and track maintenance issues and repair orders while recording assignment history through scheduled maintenance handlers and issue creation controllers.',
    { kind: 'capability', name: 'Maintenance Issue Management', target: { related_domains: ['maintenance'] } },
    groundingCas({ primary_domain: 'fleet-maintenance', core_concepts: ['maintenance', 'repair order'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'implementation-surface-restatement');
});

test('manual capability descriptions reject state-mutation API surface summaries', async () => {
  const result = validateDescription(
    'Mutation Management lets operators approve, reject, and pause operations across approvals, connectors, and content pages when mutating state through API integrations.',
    { kind: 'capability', name: 'Mutation Management', target: { related_domains: ['approval', 'connector'] } },
    groundingCas({ primary_domain: 'marketing-operations', core_concepts: ['approval', 'connector', 'content'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-analyzer-name-restatement');
});

test('manual capability descriptions reject generic analyzer-name restatements', async () => {
  const result = validateDescription(
    'Mutation Management lets operators approve requests and pause active work in business operations workflows.',
    { kind: 'capability', name: 'Mutation Management', target: { related_domains: ['approval', 'operation'] } },
    groundingCas({ primary_domain: 'business-operations', core_concepts: ['approval', 'operation'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-analyzer-name-restatement');
});

test('manual capability descriptions reject function-call analyzer-name restatements', async () => {
  const result = validateDescription(
    'Function Call Management lets an analyzer resolve and track function calls within codebases by parsing function signatures, generating unique identifiers, and mapping call chains to components and entities when analyzing work orders and user records.',
    { kind: 'capability', name: 'Function Call Management', target: { related_domains: ['call-graph'] } },
    groundingCas({ primary_domain: 'codebase-analysis', core_concepts: ['call graph', 'function analysis'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-analyzer-name-restatement');
});

test('manual capability descriptions reject UI event bucket summaries', async () => {
  const result = validateDescription(
    'Click Management lets users coordinate pages Overview and pages Profit Machine when handling click events to navigate and interact with detailed views of entities like tasks, approvals, and staff summaries.',
    { kind: 'capability', name: 'Click Management', target: { related_domains: ['task', 'approval', 'staff'] } },
    groundingCas({ primary_domain: 'business-operations', core_concepts: ['task', 'approval', 'staff'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-analyzer-name-restatement');
});

test('manual capability descriptions reject indirect page-surface summaries', async () => {
  const result = validateDescription(
    'Content Management lets operators coordinate publishing choices across approvals, connectors, and content pages.',
    { kind: 'capability', name: 'Content Management', target: { related_domains: ['content'] } },
    groundingCas({ primary_domain: 'content-operations', core_concepts: ['content', 'publishing'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'implementation-surface-restatement');
});

test('manual capability descriptions reject prompt-scaffold echoes', async () => {
  const result = validateDescription(
    'Save Management helps engineers update and maintain persistent state information for user sessions, agent configurations, and system settings across platform interactions before a codebase decision involving data consistency or runtime behavior.',
    { kind: 'capability', name: 'Save Management', target: { related_domains: ['session'] } },
    groundingCas({ primary_domain: 'agent-runtime', core_concepts: ['session', 'agent configuration', 'runtime'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-structural-phrase');
});

test('manual capability descriptions reject benchmark-report mismatches', async () => {
  const result = validateDescription(
    'Analysis Focus Benchmark Report lets an agent evaluate and compare different analysis focus configurations by generating a structured report that includes gate statuses, work unit estimates, and recommended focus layers for supported analysis tasks.',
    { kind: 'capability', name: 'Codebase Analysis', target: { related_domains: ['codebase', 'analysis'] } },
    groundingCas({ primary_domain: 'codebase-analysis', core_concepts: ['codebase', 'analysis'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-structural-phrase');
});

test('manual capability descriptions reject vague code-understanding outcomes', async () => {
  const result = validateDescription(
    'CAS Contract Validation ensures analysis outputs meet expected schemas and rules by checking conformance with defined contracts before they are used, enabling validated code understanding and modification.',
    { kind: 'capability', name: 'CAS Contract Validation', target: { related_domains: ['cas', 'contract', 'validation'] } },
    groundingCas({ primary_domain: 'codebase-analysis', core_concepts: ['CAS', 'contract', 'validation'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-structural-phrase');
});

test('manual capability descriptions reject missing-subject lowercase fragments', async () => {
  const result = validateDescription(
    'download documents and media attachments when handling document and media retrieval tasks.',
    { kind: 'capability', name: 'Download Management', target: { related_domains: ['download', 'media'] } },
    groundingCas({ primary_domain: 'message-integration', core_concepts: ['download', 'media'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-subject');
});

test('manual capability descriptions reject inventory-list descriptions', async () => {
  const result = validateDescription(
    'Sanitize Management lets an agent sanitize Filename, Reply Directive Text, Irc Outbound Text, Irc Target, User Id List, Path Segment, Profile Urls, and Profile For Display to ensure safe and standardized data handling and protocols.',
    { kind: 'capability', name: 'Sanitize Management', target: { related_domains: ['sanitize'] } },
    groundingCas({ primary_domain: 'message-integration', core_concepts: ['sanitize', 'message'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'inventory-list-description');
});

test('manual capability descriptions reject script/platform filler from local models', async () => {
  const result = validateDescription(
    'Image Management lets an agent send and process images in matrix format when scripts generate image attachments for communication across platforms.',
    { kind: 'capability', name: 'Image Management', target: { related_domains: ['image'] } },
    groundingCas({ primary_domain: 'agent-browser-automation', core_concepts: ['image', 'browser automation', 'message attachment'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-structural-phrase');
});

test('manual capability descriptions reject device/script spread filler from local models', async () => {
  const result = validateDescription(
    'Pick Management lets an operator coordinate pick operations across devices and scripts when resolving targets and debugging script usage.',
    { kind: 'capability', name: 'Pick Management', target: { related_domains: ['pick'] } },
    groundingCas({ primary_domain: 'agent-browser-automation', core_concepts: ['pick', 'browser target', 'automation session'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generic-structural-phrase');
});

test('manual capability descriptions reject over-narrow connector claims for broad capabilities', () => {
  const target = {
    kind: 'capability' as const,
    name: 'Chat Management',
    target: {
      related_domains: ['chat'],
      operations: [
        { entry_point_type: 'internal', path_or_command: 'extensions/bluebubbles/src/chat.ts' },
        { entry_point_type: 'internal', path_or_command: 'extensions/slack/src/channel.ts' },
        { entry_point_type: 'internal', path_or_command: 'extensions/matrix/src/channel.ts' },
        { entry_point_type: 'internal', path_or_command: 'extensions/discord/src/channel.ts' },
        { entry_point_type: 'internal', path_or_command: 'extensions/msteams/src/channel.ts' },
      ],
    },
  };

  const result = validateDescription(
    'BlueBubbles Chat Management lets an agent send messages and manage chat states when handling BlueBubbles communication flows.',
    target,
    groundingCas({ primary_domain: 'agent-communication', core_concepts: ['chat', 'message', 'channel'] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'over-narrow-source-area-claim');
});

test('manual capability description prompt omits internal helper operations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-context-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-context-test',
    system: { id: 'system-test', name: 'klauro', type: 'service', root_path: root },
    nodes: [{
      id: 'node-work-context',
      name: 'getAgentContext',
      type: 'function',
      source: { file: 'src/agent-adoption.ts', line: 1 },
      metadata: {},
    }],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_contexts',
      name: 'Agent Contexts',
      description: 'Agent Contexts turns graph matches and tests into compact coding context for agents.',
      category: 'core',
      criticality: 'critical',
      criticality_factors: [],
      operations: [{
        entry_point_id: 'node:node-work-context',
        entry_point_type: 'internal',
        action: 'Create',
        path_or_command: 'src/agent-adoption.ts',
      }],
      related_entities: [],
      related_domains: ['agent'],
    }] as any,
  };

  let facts: any;
  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async (context: any) => {
    facts = context.additionalContext?.target?.facts;
    return 'Agent Contexts gives coding agents compact context that points them to the right graph target, local risks, nearby tests, and validation steps before they edit.';
  };

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'Agent Contexts',
      targetKind: 'capability',
    });

    assert.equal(generated.status, 'success');
    assert.deepEqual(facts.operations, []);
    assert.deepEqual(facts.operation_concepts, ['Agent Context']);
    assert.doesNotMatch(JSON.stringify(facts), /agent-adoption\.ts|getAgentContext/);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual capability prompt derives behavior hints and excludes test-helper source evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-skill-context-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  await fs.outputFile(path.join(root, 'src/agents/skills/config.ts'), 'export function resolveSkillConfig() { return { enabled: true }; }\n');
  await fs.outputFile(path.join(root, 'src/agents/skills/frontmatter.ts'), 'export function resolveSkillInvocationPolicy() { return "automatic"; }\n');
  await fs.outputFile(path.join(root, 'src/agents/skills.e2e-test-helpers.ts'), 'export function writeSkill() { return "test helper"; }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-skill-context-test',
    system: { id: 'system-test', name: 'openclaw', type: 'library', root_path: root },
    nodes: [
      {
        id: 'node-skill-config',
        name: 'resolveSkillConfig',
        type: 'function',
        source: { file: 'src/agents/skills/config.ts', line: 1 },
        metadata: {},
      },
      {
        id: 'node-skill-policy',
        name: 'resolveSkillInvocationPolicy',
        type: 'function',
        source: { file: 'src/agents/skills/frontmatter.ts', line: 1 },
        metadata: {},
      },
      {
        id: 'node-skill-helper',
        name: 'writeSkill',
        type: 'function',
        source: { file: 'src/agents/skills.e2e-test-helpers.ts', line: 1 },
        metadata: {},
      },
    ],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_skill_management',
      name: 'Skill Management',
      description: 'Skill Management covers validate, read, update, analyze paths; spans scripts, agents, and auto reply.',
      category: 'supporting',
      criticality: 'medium',
      criticality_factors: [],
      operations: [
        {
          entry_point_id: 'node:node-skill-config',
          entry_point_type: 'internal',
          action: 'Coordinate',
          path_or_command: 'src/agents/skills/config.ts',
        },
        {
          entry_point_id: 'node:node-skill-policy',
          entry_point_type: 'internal',
          action: 'Coordinate',
          path_or_command: 'src/agents/skills/frontmatter.ts',
        },
        {
          entry_point_id: 'node:node-skill-helper',
          entry_point_type: 'internal',
          action: 'Coordinate',
          path_or_command: 'src/agents/skills.e2e-test-helpers.ts',
        },
      ],
      related_entities: [],
      related_domains: ['skill'],
    }] as any,
  };

  let facts: any;
  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async (context: any) => {
    facts = context.additionalContext?.target?.facts;
    return 'Skill Management lets agents select, configure, and validate reusable skills before applying their invocation policy to a coding session.';
  };

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'Skill Management',
      targetKind: 'capability',
    });

    assert.equal(generated.status, 'success');
    assert.ok(facts.behavior_hints.some((hint: string) => /reusable agent skill discovery/.test(hint)));
    assert.ok(facts.behavior_hints.some((hint: string) => /invocation policy/.test(hint)));
    assert.doesNotMatch(JSON.stringify({
      operations: facts.operations,
      operation_concepts: facts.operation_concepts,
      evidence_terms: facts.evidence_terms,
      source_excerpts: facts.source_excerpts,
    }), /e2e-test-helpers|test helper/);
    assert.match(generated.description, /reusable skills/i);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual capability prompt marks generic analyzer-derived names so AI uses behavior hints', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-mutation-context-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  await fs.outputFile(path.join(root, 'apps/bos-web/src/pages/Approvals.tsx'), 'export function Approvals() { return approveRequest(); }\n');
  await fs.outputFile(path.join(root, 'apps/bos-web/src/pages/Operations.tsx'), 'export function Operations() { return pauseOperation(); }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-mutation-context-test',
    system: { id: 'system-test', name: 'soon-bos', type: 'application', root_path: root },
    nodes: [
      {
        id: 'node-approval-mutation',
        name: 'mutationFn',
        type: 'function',
        source: { file: 'apps/bos-web/src/pages/Approvals.tsx', line: 1 },
        metadata: {},
      },
      {
        id: 'node-operation-mutation',
        name: 'mutationFn',
        type: 'function',
        source: { file: 'apps/bos-web/src/pages/Operations.tsx', line: 1 },
        metadata: {},
      },
    ],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_mutation_management',
      name: 'Mutation Management',
      description: 'Mutation Management covers mutation paths.',
      category: 'supporting',
      criticality: 'medium',
      criticality_factors: [],
      operations: [
        {
          entry_point_id: 'node:node-approval-mutation',
          entry_point_type: 'internal',
          action: 'Coordinate',
          path_or_command: 'apps/bos-web/src/pages/Approvals.tsx',
        },
        {
          entry_point_id: 'node:node-operation-mutation',
          entry_point_type: 'internal',
          action: 'Coordinate',
          path_or_command: 'apps/bos-web/src/pages/Operations.tsx',
        },
      ],
      related_entities: [],
      related_domains: ['mutation'],
    }] as any,
  };

  let facts: any;
  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async (context: any) => {
    facts = context.additionalContext?.target?.facts;
    return 'Approval and operation actions let operators record approval decisions and pause active work in business operations workflows.';
  };

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'Mutation Management',
      targetKind: 'capability',
    });

    assert.equal(generated.status, 'success');
    assert.equal(facts.name_quality, 'generic-analyzer-derived-name');
    assert.match(facts.name_guidance, /Do not repeat the target name/);
    assert.ok(facts.behavior_hints.some((hint: string) => /approval decision/.test(hint)));
    assert.ok(facts.behavior_hints.some((hint: string) => /pause and resume/.test(hint)));
    assert.deepEqual(facts.operation_concepts, ['Approvals', 'Operations']);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

test('manual capability descriptions repair generic analyzer-derived subject prefixes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-generic-repair-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  await fs.outputFile(path.join(root, 'apps/bos-web/src/pages/Approvals.tsx'), 'export function Approvals() { return approveRequest(); }\n');
  await fs.outputFile(path.join(root, 'apps/bos-web/src/pages/Connectors.tsx'), 'export function Connectors() { return syncConnector(); }\n');
  await fs.outputFile(path.join(root, 'apps/bos-web/src/pages/Content.tsx'), 'export function Content() { return publishContent(); }\n');

  const cas: CASOutput = {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-generic-repair-test',
    system: { id: 'system-test', name: 'soon-bos', type: 'application', root_path: root },
    nodes: [
      { id: 'node-approval-mutation', name: 'mutationFn', type: 'function', source: { file: 'apps/bos-web/src/pages/Approvals.tsx', line: 1 }, metadata: {} },
      { id: 'node-connector-mutation', name: 'mutationFn', type: 'function', source: { file: 'apps/bos-web/src/pages/Connectors.tsx', line: 1 }, metadata: {} },
      { id: 'node-content-mutation', name: 'mutationFn', type: 'function', source: { file: 'apps/bos-web/src/pages/Content.tsx', line: 1 }, metadata: {} },
    ],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    system_capabilities: [{
      id: 'cap_mutation_management',
      name: 'Mutation Management',
      description: 'Mutation Management covers mutation paths.',
      category: 'supporting',
      criticality: 'medium',
      criticality_factors: [],
      operations: [
        { entry_point_id: 'node:node-approval-mutation', entry_point_type: 'internal', action: 'Coordinate', path_or_command: 'apps/bos-web/src/pages/Approvals.tsx' },
        { entry_point_id: 'node:node-connector-mutation', entry_point_type: 'internal', action: 'Coordinate', path_or_command: 'apps/bos-web/src/pages/Connectors.tsx' },
        { entry_point_id: 'node:node-content-mutation', entry_point_type: 'internal', action: 'Coordinate', path_or_command: 'apps/bos-web/src/pages/Content.tsx' },
      ],
      related_entities: [],
      related_domains: ['mutation'],
    }] as any,
  };

  const originalGenerate = aiService.generateComponentDescription;
  aiService.generateComponentDescription = async () =>
    'Mutation Management lets an operator change the status of approvals, connectors, or content items when managing operational state or workflow progress.';

  try {
    await saveAnalysis(root, cas);
    const generated = await generateElementDescription({
      projectPath: root,
      target: 'Mutation Management',
      targetKind: 'capability',
    });

    assert.equal(generated.status, 'success');
    assert.doesNotMatch(generated.description, /^Mutation Management/);
    assert.match(generated.description, /^approval, connector, and content actions let an operator/i);
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAI;
    await fs.remove(root);
    await fs.remove(storage);
  }
});

function groundingCas(purpose: Record<string, unknown> = {}, dataEntities: unknown[] = []): CASOutput {
  return {
    enhanced_system_purpose: {
      primary_type: 'library',
      confidence: 0.8,
      evidence: [],
      primary_domain: 'order-card-carrier-management',
      core_concepts: ['order', 'card', 'carrier', 'policy', 'compliance'],
      inferred_description: 'A payments and fuel-card client managing order, card, carrier, and policy compliance workflows.',
      supporting_workflow_ids: [],
      ...purpose,
    },
    data_entities: dataEntities,
  } as unknown as CASOutput;
}

test('capability descriptions are held to the review-gate 50-char floor', () => {
  const target = {
    kind: 'capability' as const,
    name: 'Policy Management',
    target: { related_domains: ['policy'] },
  };
  // 40 chars: passed the old 35 floor but fails the usefulness review gate.
  const result = validateDescription('Policy Management holds policy records.', target, groundingCas());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-short');
});

test('marketing-flagged words grounded in system domain vocabulary are allowed for capabilities', () => {
  const target = {
    kind: 'capability' as const,
    name: 'Policy Management',
    target: { related_domains: ['policy'] },
  };
  const description = 'Policy Management maintains policy records and compliance rules applied to card and carrier workflows.';
  const result = validateDescription(description, target, groundingCas());
  assert.equal(result.ok, true, result.reason);
});

test('related entity ids are resolved to names for grounding', () => {
  const target = {
    kind: 'capability' as const,
    name: 'Transaction Settlement',
    target: { related_domains: ['transaction'], related_entities: ['entity_policy'] },
  };
  const cas = groundingCas(
    { primary_domain: 'payments', core_concepts: ['transaction', 'card'], inferred_description: 'A payments client.' },
    [{ id: 'entity_policy', name: 'CompliancePolicy' }],
  );
  const description = 'Transaction Settlement records settlement outcomes and compliance checks for each card transaction.';
  const result = validateDescription(description, target, cas);
  assert.equal(result.ok, true, result.reason);
});

test('ungrounded marketing words are still rejected and named for the repair prompt', () => {
  const target = {
    kind: 'capability' as const,
    name: 'Bundle Submission',
    target: { related_domains: ['bundle'] },
  };
  const cas = groundingCas({
    primary_domain: 'solana-trading',
    core_concepts: ['bundle', 'transaction'],
    inferred_description: 'A Solana trading bot that submits transaction bundles.',
  });
  const description = 'Bundle Submission sends transaction bundles, enhancing throughput and efficiency for the trading bot.';
  const result = validateDescription(description, target, cas);
  assert.equal(result.ok, false);
  assert.ok(result.reason?.includes('unsupported-marketing-language'));
  assert.ok(result.reason?.includes('enhancing'));
  assert.ok(result.reason?.includes('efficiency'));
});
