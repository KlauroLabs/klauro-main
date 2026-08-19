jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpringCloudGatewayAnalyzer } from '../../analyzer/frameworks/web/spring-cloud-gateway-analyzer';

describe('SpringCloudGatewayAnalyzer', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'spring-cloud-gateway-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  async function writeConfiguration(content: string): Promise<void> {
    const configurationPath = path.join(projectPath, 'src/main/resources/application.yml');
    await fs.ensureDir(path.dirname(configurationPath));
    await fs.writeFile(configurationPath, content);
  }

  it('emits load-balanced routes as navigable entry and exit boundaries', async () => {
    await writeConfiguration([
      'spring:',
      '  cloud:',
      '    gateway:',
      '      routes:',
      '        - id: inventory-service',
      '          uri: lb://inventory-service',
      '          predicates:',
      '            - Path=/api/inventory/**',
      '            - Method=GET,POST',
      '          filters:',
      '            - StripPrefix=2',
    ].join('\n'));

    const analyzer = new SpringCloudGatewayAnalyzer();
    expect(await analyzer.canAnalyze(projectPath)).toBe(true);
    const contribution = await analyzer.analyze({ projectPath });
    const route = contribution.nodes?.find(node => node.type === 'gateway_route' && node.name === 'inventory-service');

    expect(route).toBeDefined();
    expect(contribution.entry_points).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_node: route!.id, trigger: expect.objectContaining({ method: 'GET', path: '/api/inventory/**' }) }),
      expect.objectContaining({ source_node: route!.id, trigger: expect.objectContaining({ method: 'POST', path: '/api/inventory/**' }) }),
    ]));
    expect(contribution.exit_points).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_node: route!.id,
        target: expect.objectContaining({ service_id: 'inventory-service', resource: 'lb://inventory-service' }),
      }),
    ]));
    expect(contribution.edges?.some(edge => edge.target === route!.id && edge.type === 'contains')).toBe(true);
  });

  it('does not interpret unrelated YAML route lists as gateway contracts', async () => {
    await writeConfiguration([
      'application:',
      '  routes:',
      '    - id: dashboard',
      '      uri: https://dashboard.example.test',
    ].join('\n'));

    const analyzer = new SpringCloudGatewayAnalyzer();

    expect(await analyzer.canAnalyze(projectPath)).toBe(false);
    const contribution = await analyzer.analyze({ projectPath });
    expect(contribution.nodes).toHaveLength(0);
    expect(contribution.exit_points).toHaveLength(0);
  });
});
