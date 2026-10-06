import { globSync } from 'glob';
import { PROJECT_SCOPE_TRIGGER_PATTERNS } from './change-detector';
import { SCAFFOLD_GLOBS } from './scaffold-paths';
import { BUILD_ARTIFACT_GLOBS, THIRD_PARTY_SOURCE_GLOBS } from './build-artifact-paths';
import { ChangeSemanticImpact } from '../../types/cas.types';
import { CASEntryPoint, CASExitPoint, CASOutput } from '../../types/cas.types';
import { projectEntryPointFlowsFromCas } from './entry-point-flow-projection';
export function getIncrementalSourceFiles(projectPath: string): string[] {
    const coreConfigPatterns = [
      'package.json',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.*.json',
      'angular.json',
      'nest-cli.json',
      'next.config.js',
      'next.config.mjs',
      'vite.config.ts',
      'vite.config.js',
      'webpack.config.js',
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
      'pubspec.yaml',
      'pubspec.lock',
      'pom.xml',
      'build.gradle',
      'composer.json',
      'composer.lock'
    ].flatMap(pattern => [pattern, `**/${pattern}`]);
    const patterns = [
      '**/*.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.{py,pyw}',
      '**/*.java',
      '**/*.{kt,kts}',
      '**/*.{cs,vb,fs}',
      '**/*.go',
      '**/*.rs',
      '**/*.php',
      '**/*.dart',
      '**/*.prisma',
      ...PROJECT_SCOPE_TRIGGER_PATTERNS,
      ...coreConfigPatterns
    ];
    return globSync(patterns, {
      cwd: projectPath,
      ignore: [
        '**/node_modules/**',
        ...BUILD_ARTIFACT_GLOBS,
        '**/build/**',
        '**/out/**',
        '**/.git/**',
        '**/.claude/**',
        '**/.codex/**',
        '**/.agents/**',
        '**/.klauro*/**',
        '**/coverage/**',
        '**/.nyc_output/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/.cache/**',
        '**/.vite/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
        '**/target/**',
        ...THIRD_PARTY_SOURCE_GLOBS,
        '**/*_extracted/**',
        '**/*-extracted/**',
        'examples/**',
        '**/examples/**',
        ...SCAFFOLD_GLOBS,
        'samples/**',
        '**/samples/**',
        'site-packages/**',
        '**/site-packages/**',
        '.venv/**',
        '**/.venv/**',
        '.venv*/**',
        '**/.venv*/**',
        'venv/**',
        '**/venv/**',
        'venv*/**',
        '**/venv*/**',
        'env/**',
        '**/env/**',
        '.tox/**',
        '**/.tox/**',
        '.mypy_cache/**',
        '**/.mypy_cache/**',
        '.ruff_cache/**',
        '**/.ruff_cache/**',
        '**/.dart_tool/**',
        '**/storybook-static/**',
        '**/storybook-build/**',
        '**/public/assets/**',
        '**/static/assets/**',
        '**/src/assets/**',
        '**/web/assets/**',
        '**/Generated/**',
        '**/generated/**',
        '**/obj/**'
      ],
      nodir: true
    }).sort();
  }

export function buildSemanticChangeImpact(
    output: CASOutput,
    changedNodeIds: Set<string>,
    affectedEntryPointIds: Set<string>,
    affectedCallChainIds: Set<string>,
    changedEntryPoints: CASEntryPoint[],
    changedExitPoints: CASExitPoint[]
  ) {
    const affected_entry_point_flows = projectEntryPointFlowsFromCas(output).entryPointFlows
      .filter(entryPointFlow =>
        affectedEntryPointIds.has(entryPointFlow.entry_point_id) ||
        entryPointFlow.call_chain_ids.some(id => affectedCallChainIds.has(id)) ||
        entryPointFlow.steps.some(step => changedNodeIds.has(step.node_id)) ||
        entryPointFlow.terminal_entities.some(entity => !!entity.node_id && changedNodeIds.has(entity.node_id))
      )
      .map(entryPointFlow => ({
        id: entryPointFlow.id,
        name: entryPointFlow.name,
        reason: 'Changed nodes or entry points participate in this entry-point flow'
      }));

    const affected_capabilities = (output.capabilities || [])
      .filter(capability =>
        capability.operations.some(operation => affectedEntryPointIds.has(operation.entry_point_id)) ||
        capability.related_entities.some(entity => changedNodeIds.has(entity))
      )
      .map(capability => ({
        id: capability.id,
        name: capability.name,
        reason: 'Changed entry points or related entities participate in this capability'
      }));

    const affected_data_entities = (output.entities || [])
      .filter(entity => {
        const lifecycleNodes = [
          ...entity.lifecycle.created_by,
          ...entity.lifecycle.read_by,
          ...entity.lifecycle.updated_by,
          ...entity.lifecycle.deleted_by
        ];
        const transformationNodes = (entity.transformations || [])
          .flatMap(transformation => [transformation.from_node, transformation.to_node]);
        return [...lifecycleNodes, ...transformationNodes].some(nodeId => changedNodeIds.has(nodeId));
      })
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        reason: 'Changed nodes participate in this entity lifecycle'
      }));

    const affected_runtime_links = (output.runtime_static_links || [])
      .filter(link =>
        link.instrumentation_points.some(nodeId => changedNodeIds.has(nodeId)) ||
        affectedEntryPointIds.has(link.static_id) ||
        affectedCallChainIds.has(link.static_id)
      )
      .map(link => ({
        id: link.id,
        runtime_signal: link.runtime_signal,
        reason: 'Changed nodes are runtime instrumentation points'
      }));

    const changed_contracts = [
      ...changedEntryPoints.map(entryPoint => ({
        id: entryPoint.id,
        type: 'entry-point' as const,
        name: entryPoint.name
      })),
      ...changedExitPoints.map(exitPoint => ({
        id: exitPoint.id,
        type: 'exit-point' as const,
        name: exitPoint.name
      }))
    ];

    const risk_reasons: string[] = [];
    if (affected_entry_point_flows.length > 0) risk_reasons.push(`${affected_entry_point_flows.length} entry-point flow(s) affected`);
    if (affected_capabilities.length > 0) risk_reasons.push(`${affected_capabilities.length} capability/capabilities affected`);
    if (affected_data_entities.length > 0) risk_reasons.push(`${affected_data_entities.length} data entity/entities affected`);
    if (affected_runtime_links.length > 0) risk_reasons.push(`${affected_runtime_links.length} runtime signal(s) affected`);
    if (changed_contracts.length > 0) risk_reasons.push(`${changed_contracts.length} externally visible contract(s) changed`);

    return {
      affected_entry_point_flows,
      affected_capabilities,
      affected_data_entities,
      affected_runtime_links,
      changed_contracts,
      risk_reasons
    };
  }

export function buildScopedSemanticChangeImpact(
    currentOutput: CASOutput,
    changedNodeIds: Set<string>,
    affectedEntryPointIds: Set<string>,
    affectedCallChainIds: Set<string>,
    changedEntryPoints: CASEntryPoint[],
    changedExitPoints: CASExitPoint[]
  ): ChangeSemanticImpact {
    const affected_entry_point_flows = projectEntryPointFlowsFromCas(currentOutput).entryPointFlows
      .filter(entryPointFlow =>
        entryPointFlow.call_chain_ids.some(id => affectedCallChainIds.has(id)) ||
        affectedEntryPointIds.has(entryPointFlow.entry_point_id)
      )
      .slice(0, 20)
      .map(entryPointFlow => ({
        id: entryPointFlow.id,
        name: entryPointFlow.name,
        reason: 'Entry-point flow is connected to a changed file or entry point'
      }));
    const affected_capabilities = (currentOutput.capabilities || [])
      .filter(capability =>
        capability.operations.some(operation => changedNodeIds.has(operation.entry_point_id.replace(/^node:/, ''))) ||
        capability.related_entities.some(entityId => changedNodeIds.has(entityId))
      )
      .slice(0, 20)
      .map(capability => ({
        id: capability.id,
        name: capability.name,
        reason: 'Capability references changed graph facts'
      }));
    const affected_data_entities = (currentOutput.entities || [])
      .filter(entity => [
        ...entity.lifecycle.created_by,
        ...entity.lifecycle.read_by,
        ...entity.lifecycle.updated_by,
        ...entity.lifecycle.deleted_by,
      ].some(nodeId => changedNodeIds.has(nodeId)))
      .slice(0, 20)
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        reason: 'Entity lifecycle references changed node'
      }));
    const affected_runtime_links = (currentOutput.runtime_static_links || [])
      .filter(link => changedNodeIds.has(link.static_id))
      .slice(0, 20)
      .map(link => ({
        id: link.id,
        runtime_signal: link.runtime_signal,
        reason: 'Runtime link is attached to changed node'
      }));
    const changed_contracts = [
      ...changedEntryPoints.map(entryPoint => ({
        id: entryPoint.id,
        type: 'entry-point' as const,
        name: entryPoint.name
      })),
      ...changedExitPoints.map(exitPoint => ({
        id: exitPoint.id,
        type: 'exit-point' as const,
        name: exitPoint.name
      })),
    ];
    const risk_reasons: string[] = [];
    if (affected_entry_point_flows.length > 0) risk_reasons.push('Changed nodes are connected to entry-point flow paths');
    if (affected_data_entities.length > 0) risk_reasons.push('Changed nodes participate in data entity lifecycle');
    if (changed_contracts.length > 0) risk_reasons.push('Entry or exit contracts changed');
    return {
      affected_entry_point_flows,
      affected_capabilities,
      affected_data_entities,
      affected_runtime_links,
      changed_contracts,
      risk_reasons
    };
  }
