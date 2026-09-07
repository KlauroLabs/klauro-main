import type { CASExitPoint, CASExternalService, CASNode } from '../../types/cas.types';
import { externalServiceIdentityForExitPoint } from './external-service-identity';
import { isLanguageBuiltinExitPoint, isLanguageBuiltinName } from './language-builtins';

export function buildExternalServices(
  nodes: CASNode[],
  exitPoints: CASExitPoint[],
  libraries: any[],
  isMeaningfulExternalServiceName: (name: string | undefined) => boolean,
): CASExternalService[] {
  const services: CASExternalService[] = [];
  const serviceMap = new Map<string, CASExternalService>();

  exitPoints.forEach(ep => {
    if (ep.type === 'database') {
      const dbKey = ep.target?.service_id || 'primary_database';
      if (!serviceMap.has(dbKey)) {
        const databaseName = isMeaningfulExternalServiceName(ep.name) ? ep.name : 'Database';
        serviceMap.set(dbKey, {
          id: `ext_${dbKey}`,
          name: databaseName || 'Database',
          type: 'database',
          purpose: 'bidirectional',
          connected_nodes: [],
          exit_points: []
        });
      }
      const svc = serviceMap.get(dbKey)!;
      if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
        svc.connected_nodes?.push(ep.source_node);
      }
      svc.exit_points?.push(ep.id);
    } else if (ep.type === 'cache') {
      const cacheKey = 'redis_cache';
      if (!serviceMap.has(cacheKey)) {
        serviceMap.set(cacheKey, {
          id: `ext_${cacheKey}`,
          name: 'Redis',
          type: 'cache',
          purpose: 'bidirectional',
          usage_pattern: {
            operations: []
          },
          connected_nodes: [],
          exit_points: []
        });
      }
      const svc = serviceMap.get(cacheKey)!;
      if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
        svc.connected_nodes?.push(ep.source_node);
      }
      svc.exit_points?.push(ep.id);
    } else if (ep.type === 'api' || ep.type === 'sdk') {
      const sdkName = externalServiceIdentityForExitPoint(ep);

      if (!sdkName || isLanguageBuiltinName(sdkName) || isLanguageBuiltinExitPoint(ep) || !isMeaningfulExternalServiceName(sdkName)) {
        return;
      }

      const key = sdkName.toLowerCase().replace(/\s+/g, '_');

      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          id: `ext_${key}`,
          name: sdkName,
          type: ep.type === 'sdk' ? 'sdk' : 'api',
          purpose: 'consumption',
          connected_nodes: [],
          exit_points: []
        });
      }
      const svc = serviceMap.get(key)!;
      if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
        svc.connected_nodes?.push(ep.source_node);
      }
      svc.exit_points?.push(ep.id);
    }
  });

  const aiLibraries = libraries.filter(l =>
    l.name?.includes('openai') ||
    l.name?.includes('anthropic') ||
    l.name?.includes('@anthropic-ai')
  );

  const nodesById = new Map<string, CASNode>();
  if (aiLibraries.length > 0) {
    for (const node of nodes) {
      if (!nodesById.has(node.id)) nodesById.set(node.id, node);
    }
  }

  aiLibraries.forEach(lib => {
    const key = lib.name?.includes('openai') ? 'openai' : 'anthropic';
    const providerService = Array.from(serviceMap.values()).find(service =>
      service.connected_nodes?.some(nodeId => {
        const node = nodesById.get(nodeId);
        return node?.analyzers?.some(analyzer => analyzer.toLowerCase().includes(key));
      })
    );
    if (providerService) {
      providerService.name = key === 'openai' ? 'OpenAI' : 'Anthropic';
      providerService.type = 'ai_provider';
      providerService.configuration = { library: lib.name, version: lib.version };
    } else if (!serviceMap.has(key)) {
      serviceMap.set(key, {
        id: `ext_${key}`,
        name: key === 'openai' ? 'OpenAI' : 'Anthropic',
        type: 'ai_provider',
        purpose: 'consumption',
        configuration: {
          library: lib.name,
          version: lib.version
        }
      });
    }
  });

  serviceMap.forEach(svc => services.push(svc));

  return services;
}
