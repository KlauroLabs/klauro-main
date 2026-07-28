jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { JavaAnalyzer } from '../../../analyzer/languages/java-analyzer';
import { CASNode } from '../../../types/cas.types';

/**
 * Regression (P0, silent data loss): spring-petclinic-microservices DTO
 * records (PetType.java, VisitDetails.java, VetsProperties.java, ...) were
 * flagged `PARTIAL_ANALYSIS` / "contains declaration keywords but no code
 * elements could be extracted" even though every one of them is valid,
 * compiling Java. Root cause: JavaAnalyzer#extractClasses only matches the
 * literal `class` keyword, so files containing nothing but a `record`
 * declaration (Java 16+, ubiquitous for Spring DTOs) produced zero
 * extracted nodes, tripping the heuristic and dropping the record - and its
 * fields - from the graph entirely. Fixed via JavaAnalyzer#extractRecords,
 * which treats the record's component list as its fields and reuses the
 * class node pipeline; it also joins component lists that wrap across
 * lines (e.g. `@ConfigurationProperties` records).
 */
describe('JavaAnalyzer record extraction', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-records-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function analyzeJava(fileName: string, source: string): Promise<{ nodes: CASNode[]; analyzer: JavaAnalyzer }> {
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, source, 'utf-8');
    const analyzer = new JavaAnalyzer();
    const result = await analyzer.analyzeFileSingle({
      projectPath: tmpDir,
      filePath,
      relativePath: fileName,
    });
    return { nodes: result.nodes, analyzer };
  }

  it('extracts a single-line record and its components as fields', async () => {
    const source = [
      'package org.springframework.samples.petclinic.api.dto;',
      '',
      'public record PetType(String name) {',
      '}',
      '',
    ].join('\n');

    const { nodes, analyzer } = await analyzeJava('PetType.java', source);
    const classNode = nodes.find(n => n.type === 'class' && n.name === 'PetType');
    expect(classNode).toBeDefined();

    const fieldNode = nodes.find(n => n.type === 'field' && n.name === 'name');
    expect(fieldNode).toBeDefined();

    const warnings: string[] = (analyzer as unknown as { analysisWarnings: string[] }).analysisWarnings || [];
    expect(warnings.filter(w => w.includes('no code elements'))).toHaveLength(0);
  });

  it('extracts a record whose component list wraps across lines, including a nested record', async () => {
    const source = [
      'package org.springframework.samples.petclinic.vets.system;',
      '',
      'import org.springframework.boot.context.properties.ConfigurationProperties;',
      '',
      '@ConfigurationProperties(prefix = "vets")',
      'public record VetsProperties(',
      '    Cache cache',
      ') {',
      '    public record Cache(',
      '        int ttl,',
      '        int heapSize',
      '    ) {',
      '    }',
      '}',
      '',
    ].join('\n');

    const { nodes, analyzer } = await analyzeJava('VetsProperties.java', source);
    const outer = nodes.find(n => n.type === 'class' && n.name === 'VetsProperties');
    expect(outer).toBeDefined();

    const cacheField = nodes.find(n => n.type === 'field' && n.name === 'cache');
    expect(cacheField).toBeDefined();

    const inner = nodes.find(n => n.type === 'class' && n.name === 'Cache');
    expect(inner).toBeDefined();
    const ttlField = nodes.find(n => n.type === 'field' && n.name === 'ttl');
    expect(ttlField).toBeDefined();

    const warnings: string[] = (analyzer as unknown as { analysisWarnings: string[] }).analysisWarnings || [];
    expect(warnings.filter(w => w.includes('no code elements'))).toHaveLength(0);
  });

  it('extracts a record whose components carry validation annotations across lines', async () => {
    const source = [
      'package org.springframework.samples.petclinic.customers.web;',
      '',
      'import jakarta.validation.constraints.Digits;',
      'import jakarta.validation.constraints.NotBlank;',
      '',
      'public record OwnerRequest(@NotBlank String firstName,',
      '                           @NotBlank String lastName,',
      '                           @NotBlank',
      '                           @Digits(fraction = 0, integer = 12)',
      '                           String telephone',
      ') {',
      '}',
      '',
    ].join('\n');

    const { nodes, analyzer } = await analyzeJava('OwnerRequest.java', source);
    const classNode = nodes.find(n => n.type === 'class' && n.name === 'OwnerRequest');
    expect(classNode).toBeDefined();

    const firstName = nodes.find(n => n.type === 'field' && n.name === 'firstName');
    const telephone = nodes.find(n => n.type === 'field' && n.name === 'telephone');
    expect(firstName).toBeDefined();
    expect(telephone).toBeDefined();

    const warnings: string[] = (analyzer as unknown as { analysisWarnings: string[] }).analysisWarnings || [];
    expect(warnings.filter(w => w.includes('no code elements'))).toHaveLength(0);
  });
});
