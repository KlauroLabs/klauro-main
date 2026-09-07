import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createOrchestrator } from './analyzer';
import { LANGUAGE_REGISTRY } from '../../../packages/analyzer-core/src/analyzer/core/language-registry';
import { LANGUAGE_SPECS } from '../../../packages/analyzer-core/src/analyzer/core/language-spec';

const TYPESCRIPT_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer');
const GENERIC_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/languages/generic-tree-sitter-language-analyzer');
const WEB_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/frameworks/web/react-analyzer');
const DATA_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/airflow-analyzer');
const LIBRARY_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/libraries/auth/auth-analyzer');
const ORM_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/libraries/orm/typeorm-analyzer');
const CONTAINER_ANALYZERS_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer');
const TEST_ANALYZERS_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/frameworks/testing');
const GRAPHQL_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/libraries/graphql-analyzer');
const PACK_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/packs');

test('analyzer registration listing and unmatched detection do not load lazy implementations', async () => {
  const unmatchedImplementationPaths = [TYPESCRIPT_ANALYZER_PATH, GENERIC_ANALYZER_PATH, WEB_ANALYZER_PATH, DATA_ANALYZER_PATH, LIBRARY_ANALYZER_PATH, ORM_ANALYZER_PATH, CONTAINER_ANALYZERS_PATH, TEST_ANALYZERS_PATH, GRAPHQL_ANALYZER_PATH];
  for (const implementationPath of [...unmatchedImplementationPaths, PACK_ANALYZER_PATH]) delete require.cache[implementationPath];
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-lazy-analyzer-'));
  try {
    const orchestrator = createOrchestrator();
    const registration = orchestrator.listRegisteredAnalyzers().find(item => item.id === 'typescript-javascript');
    assert.equal(registration?.incremental, true);
    for (const implementationPath of unmatchedImplementationPaths) assert.equal(require.cache[implementationPath], undefined);
    assert.equal(require.cache[PACK_ANALYZER_PATH], undefined);

    (orchestrator as any).applyLocalPackGlobs(['packs/*.json']);
    assert.notEqual(require.cache[PACK_ANALYZER_PATH], undefined);
    assert.deepEqual((orchestrator as any).analyzers.get('analyzer-packs').analyzer.localPackGlobs, ['packs/*.json']);
    await orchestrator.detectAnalyzers(projectPath);
    for (const implementationPath of unmatchedImplementationPaths) assert.equal(require.cache[implementationPath], undefined);
  } finally {
    await fs.remove(projectPath);
  }
});

test('lazy registration metadata matches analyzer incremental support', () => {
  const orchestrator = createOrchestrator() as any;
  const listed = new Map(orchestrator.listRegisteredAnalyzers().map((registration: { id: string; incremental: boolean }) => [registration.id, registration.incremental]));
  for (const registration of orchestrator.analyzers.values()) {
    assert.equal(listed.get(registration.id), Boolean(registration.analyzer.supportsIncrementalAnalysis?.()), registration.id);
    assert.equal(registration.discoversNestedRoots ?? false, Boolean(registration.analyzer.discoversNestedRoots), registration.id);
  }
});

test('registration-driven language detection matches analyzer detection on a representative project', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-language-detection-'));
  const files: Record<string, string> = {
    'main.ts': 'export const value = 1;',
    'main.py': 'value = 1',
    'Main.java': 'class Main {}',
    'Main.cs': 'class Main {}',
    'main.go': 'package main',
    'main.rs': 'fn main() {}',
    'main.php': '<?php echo "ok";',
    'main.rb': 'puts "ok"',
    'main.dart': 'void main() {}',
    'main.swift': 'let value = 1',
    'main.kt': 'fun main() {}',
    'main.ex': 'defmodule Main do end',
    'schema.proto': 'syntax = "proto3";',
    'service.wsdl': '<definitions/>',
    'main.tf': 'terraform {}',
    'schema.sql': 'CREATE TABLE items (id INT);',
    'store.js': 'writeFileSync("state.json", JSON.stringify(value)); const value = JSON.parse(readFileSync("state.json", "utf8"));',
    'Dockerfile': 'FROM node:22',
    'compose.yml': 'services:\n  api:\n    image: api',
    'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec: {}',
    'playbook.yml': '- hosts: all',
    'Pulumi.yaml': 'runtime: nodejs',
    'Chart.yaml': 'apiVersion: v2',
    'Caddyfile': 'reverse_proxy localhost:3000',
    'nginx.conf': 'server { location / { proxy_pass http://app; } }',
    'haproxy.cfg': 'frontend api',
    'traefik.yml': 'routers:\n  api:\n    rule: Host(`example.test`)',
    'install.ps1': 'Write-Host "install"',
    'main.zig': 'pub fn main() void {}',
  };
  try {
    await Promise.all(Object.entries(files).map(async ([file, content]) => {
      await fs.ensureDir(path.dirname(path.join(projectPath, file)));
      await fs.writeFile(path.join(projectPath, file), content);
    }));
    const orchestrator = createOrchestrator() as any;
    const detectedIds = new Set((await orchestrator.detectAnalyzers(projectPath)).map((registration: { id: string }) => registration.id));
    const representativeIds = new Set(['typescript-javascript', 'python', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'elixir', 'protobuf', 'soap-wsdl', 'dart', 'terraform', 'generic-tree-sitter']);
    for (const registration of orchestrator.analyzers.values()) {
      if (!representativeIds.has(registration.id)) continue;
      assert.equal(detectedIds.has(registration.id), await registration.analyzer.canAnalyze(projectPath), registration.id);
    }
  } finally {
    await fs.remove(projectPath);
  }
});

test('lazy breadth detection includes every supported extension and detects an isolated R project', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-breadth-detection-'));
  try {
    const orchestrator = createOrchestrator() as any;
    const registration = orchestrator.analyzers.get('generic-tree-sitter');
    const implementation = new (require(GENERIC_ANALYZER_PATH).GenericTreeSitterLanguageAnalyzer)();
    const { LanguageAnalyzers } = require('../../../packages/analyzer-core/src/analyzer/core/language-analyzer-catalog');
    const extensions = new Set<string>(registration.detectPatterns.files);
    let checked = 0;
    for (const entry of LANGUAGE_REGISTRY) {
      if (entry.id in LanguageAnalyzers || !LANGUAGE_SPECS[entry.id]) continue;
      for (const extension of entry.extensions) {
        assert.ok(extensions.has(`**/*.${extension.toLowerCase()}`), `${entry.id}: .${extension} must reach its analyzer`);
        checked += 1;
      }
    }
    assert.ok(checked > 100, 'check the complete breadth registry, not a small extension sample');
    await fs.writeFile(path.join(projectPath, 'main.r'), 'run <- function() helper(5)\n');
    assert.equal(await implementation.canAnalyze(projectPath), true);
    const detected = await orchestrator.detectAnalyzers(projectPath);
    assert.ok(detected.some((item: { id: string }) => item.id === 'generic-tree-sitter'));
  } finally {
    await fs.remove(projectPath);
  }
});
