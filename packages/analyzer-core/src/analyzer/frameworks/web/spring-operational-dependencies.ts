import * as path from 'path';
import * as fs from 'fs-extra';
import type { CASNode, CASExitPoint } from '../../../types/cas.types';
import { cachedGlob as glob } from '../../core/glob-cache';

interface OperationalDependencyInput {
  projectPath: string;
  application: { filePath: string; enabledFeatures: string[] } | null;
  ignorePatterns: string[];
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '_');
}

export async function discoverSpringOperationalDependencies(
  input: OperationalDependencyInput,
): Promise<{ nodes: CASNode[]; exitPoints: CASExitPoint[] }> {
  const nodes: CASNode[] = [];
  const exitPoints: CASExitPoint[] = [];
  const pomPath = path.join(input.projectPath, 'pom.xml');
  const pom = await fs.pathExists(pomPath) ? await fs.readFile(pomPath, 'utf-8') : '';
  if (input.application?.enabledFeatures.includes('DiscoveryClient')) {
    const eureka = pom.includes('spring-cloud-starter-netflix-eureka-client');
    const serviceId = eureka ? 'eureka' : 'service-discovery';
    const name = eureka ? 'Eureka Service Registry' : 'Service Discovery';
    const nodeId = `external_${sanitizeId(serviceId)}`;
    nodes.push({
      id: nodeId, name, type: 'external-service', level: 2, level_name: 'architectural',
      category: 'external-service', subcategories: ['service-discovery', 'spring-cloud'],
      source: { file: input.application.filePath, line: 1 },
      description: `Spring Cloud discovery client integration with ${name}`,
      analyzers: ['spring-boot'],
      metadata: { framework: 'spring-cloud', attributes: { serviceId, evidence: '@EnableDiscoveryClient' } },
    });
    exitPoints.push({
      id: `exit_${nodeId}`, source_node: nodeId, source_analyzer: 'spring-boot', type: 'api', name,
      description: `Registers with and discovers services through ${name}`,
      target: { service_id: serviceId }, operation: { action: 'register-and-discover', async: true },
      metadata: { framework: 'spring-cloud', evidence: '@EnableDiscoveryClient' },
    });
  }
  const configurationFiles = await glob(
    ['**/application*.yml', '**/application*.yaml', '**/application*.properties'],
    { cwd: input.projectPath, ignore: input.ignorePatterns, nodir: true },
  );
  for (const file of configurationFiles.sort()) {
    const content = await fs.readFile(path.join(input.projectPath, file), 'utf-8');
    const imports = [...content.matchAll(/(?:optional:)?configserver:([^\s"']+)/g)];
    for (let index = 0; index < imports.length; index++) {
      const endpoint = imports[index][1];
      const nodeId = `external_spring_config_${sanitizeId(file)}_${index}`;
      nodes.push({
        id: nodeId, name: 'Spring Config Server', type: 'external-service', level: 2, level_name: 'architectural',
        category: 'external-service', subcategories: ['configuration', 'spring-cloud'],
        source: { file, line: content.slice(0, imports[index].index || 0).split('\n').length },
        description: 'Spring Cloud Config server used to load runtime configuration',
        analyzers: ['spring-boot'],
        metadata: { framework: 'spring-cloud-config', attributes: { endpoint } },
      });
      exitPoints.push({
        id: `exit_${nodeId}`, source_node: nodeId, source_analyzer: 'spring-boot', type: 'api',
        name: 'Spring Config Server', description: 'Loads runtime configuration from Spring Cloud Config',
        target: { service_id: 'spring-config', endpoint }, operation: { action: 'load-configuration', async: false },
        metadata: { framework: 'spring-cloud-config', file },
      });
    }
  }
  return { nodes, exitPoints };
}
