import {
  CASCapability,
  CASCapabilityDependency,
  CASNode,
  CASEdge,
  CASDataEntity,
  CASDatabaseSchema
} from '../../types/cas.types';

export class CapabilityDependencyBuilder {
  buildDependencies(
    capabilities: CASCapability[],
    nodes: CASNode[],
    edges: CASEdge[],
    entities?: CASDataEntity[],
    databaseSchema?: CASDatabaseSchema
  ): CASCapabilityDependency[] {
    const dependencies: CASCapabilityDependency[] = [];

    this.buildSharedServiceDependencies(capabilities, dependencies);

    if (entities && databaseSchema) {
      this.buildEntityDependencies(capabilities, entities, databaseSchema, dependencies);
    }

    this.buildCallDependencies(capabilities, edges, nodes, dependencies);

    this.buildDataFlowDependencies(capabilities, nodes, dependencies);

    this.buildSemanticDependencies(capabilities, dependencies);

    return this.deduplicateAndRank(dependencies);
  }

  private buildSharedServiceDependencies(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): void {
    for (let i = 0; i < capabilities.length; i++) {
      for (let j = i + 1; j < capabilities.length; j++) {
        const cap1 = capabilities[i];
        const cap2 = capabilities[j];

        const sharedServices = cap1.services_used.filter(s =>
          cap2.services_used.includes(s)
        );

        if (sharedServices.length > 0) {
          const cap1Score = cap1.entry_points.length;
          const cap2Score = cap2.entry_points.length;

          const fromCap = cap1Score > cap2Score ? cap2 : cap1;
          const toCap = cap1Score > cap2Score ? cap1 : cap2;

          dependencies.push({
            from_capability: fromCap.id,
            to_capability: toCap.id,
            dependency_type: 'uses',
            strength: sharedServices.length > 2 ? 'common' : 'optional',
            evidence: {
              shared_services: sharedServices,
              shared_nodes: []
            },
            description: `Shares ${sharedServices.length} service${sharedServices.length > 1 ? 's' : ''}`
          });
        }
      }
    }
  }

  private buildEntityDependencies(
    capabilities: CASCapability[],
    entities: CASDataEntity[],
    databaseSchema: CASDatabaseSchema,
    dependencies: CASCapabilityDependency[]
  ): void {
    for (const dbEntity of databaseSchema.entities) {
      for (const rel of dbEntity.relationships) {
        const sourceCapability = this.findCapabilityForEntity(capabilities, dbEntity.name);
        const targetCapability = this.findCapabilityForEntity(capabilities, rel.target);

        if (sourceCapability && targetCapability && sourceCapability.id !== targetCapability.id) {
          const isRequired = rel.type === 'ManyToOne' || rel.type === 'OneToOne';

          dependencies.push({
            from_capability: sourceCapability.id,
            to_capability: targetCapability.id,
            dependency_type: isRequired ? 'requires' : 'shares-data',
            strength: isRequired ? 'required' : 'common',
            evidence: {
              shared_services: [],
              shared_entities: [dbEntity.name, rel.target],
              shared_nodes: []
            },
            description: `${dbEntity.name} ${rel.type} ${rel.target}`
          });
        }
      }
    }

    for (const entity of entities) {
      const createdBy = entity.lifecycle?.created_by || [];
      const readBy = entity.lifecycle?.read_by || [];
      const updatedBy = entity.lifecycle?.updated_by || [];

      const creatorCaps = this.findCapabilitiesForNodes(capabilities, createdBy);
      const readerCaps = this.findCapabilitiesForNodes(capabilities, readBy);
      const updaterCaps = this.findCapabilitiesForNodes(capabilities, updatedBy);

      for (const readerCap of readerCaps) {
        for (const creatorCap of creatorCaps) {
          if (readerCap.id !== creatorCap.id) {
            dependencies.push({
              from_capability: readerCap.id,
              to_capability: creatorCap.id,
              dependency_type: 'requires',
              strength: 'required',
              evidence: {
                shared_services: [],
                shared_entities: [entity.id],
                shared_nodes: []
              },
              description: `Reads ${entity.name} created by ${creatorCap.name}`
            });
          }
        }
      }

      for (const updaterCap of updaterCaps) {
        for (const creatorCap of creatorCaps) {
          if (updaterCap.id !== creatorCap.id) {
            dependencies.push({
              from_capability: updaterCap.id,
              to_capability: creatorCap.id,
              dependency_type: 'requires',
              strength: 'required',
              evidence: {
                shared_services: [],
                shared_entities: [entity.id],
                shared_nodes: []
              },
              description: `Updates ${entity.name} created by ${creatorCap.name}`
            });
          }
        }
      }
    }
  }

  private buildCallDependencies(
    capabilities: CASCapability[],
    edges: CASEdge[],
    nodes: CASNode[],
    dependencies: CASCapabilityDependency[]
  ): void {
    const nodeToCapability = new Map<string, CASCapability>();
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const operationFileHints = capabilities.map(cap => ({
      cap,
      fileNames: cap.operations
        .map(op => op.trigger?.path || '')
        .map(opPath => opPath.split('/').pop() || '')
        .filter(Boolean)
    })).filter(item => item.fileNames.length > 0);

    for (const cap of capabilities) {
      for (const service of cap.services_used) {
        nodeToCapability.set(service, cap);
      }

      for (const op of cap.operations) {
        if (op.implementing_nodes) {
          for (const nodeId of op.implementing_nodes) {
            nodeToCapability.set(nodeId, cap);
          }
        }
      }
    }

    const entryNodeToCapability = new Map<string, CASCapability>();
    for (const cap of capabilities) {
      for (const op of cap.operations) {
        if (op.entry_point_id) {
          const entryPointId = op.entry_point_id.replace('entry_', '');
          entryNodeToCapability.set(entryPointId, cap);

          const routeNodeId = entryPointId.replace('entry_', '');
          nodeToCapability.set(routeNodeId, cap);
        }
      }
    }

    const callEdges = edges.filter(e =>
      e.type === 'calls' || e.type === 'depends_on' || e.type === 'uses' ||
      e.type === 'queries' || e.type === 'wraps' || e.type === 'maps_to'
    );

    const capabilityCallCounts = new Map<string, Map<string, number>>();

    for (const edge of callEdges) {
      let sourceCap = nodeToCapability.get(edge.source);
      let targetCap = nodeToCapability.get(edge.target);

      if (!sourceCap) {
        const sourceNode = nodesById.get(edge.source);
        if (sourceNode?.source?.file) {
          for (const item of operationFileHints) {
            if (item.fileNames.some(fileName => sourceNode.source?.file?.includes(fileName))) {
              sourceCap = item.cap;
              break;
            }
          }
        }
      }

      if (sourceCap && targetCap && sourceCap.id !== targetCap.id) {
        const key = `${sourceCap.id}|${targetCap.id}`;

        if (!capabilityCallCounts.has(key)) {
          capabilityCallCounts.set(key, new Map());
        }
        const counts = capabilityCallCounts.get(key)!;
        counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
      }
    }

    for (const key of Array.from(capabilityCallCounts.keys())) {
      const nodeCounts = capabilityCallCounts.get(key)!;
      const [fromId, toId] = key.split('|');
      const values = Array.from(nodeCounts.values()) as number[];
      const totalCalls = values.reduce((a: number, b: number) => a + b, 0);
      const sharedNodes = Array.from(nodeCounts.keys()) as string[];

      dependencies.push({
        from_capability: fromId,
        to_capability: toId,
        dependency_type: 'uses',
        strength: totalCalls > 5 ? 'common' : 'optional',
        evidence: {
          shared_services: [],
          shared_nodes: sharedNodes,
          call_count: totalCalls
        },
        description: `${totalCalls} call${totalCalls > 1 ? 's' : ''} between capabilities`
      });
    }
  }

  private buildDataFlowDependencies(
    capabilities: CASCapability[],
    nodes: CASNode[],
    dependencies: CASCapabilityDependency[]
  ): void {
    const producerPatterns = ['create', 'transform', 'action'];
    const consumerPatterns = ['query', 'crud'];

    const producers = capabilities.filter(cap =>
      cap.operation_patterns.some(p => producerPatterns.includes(p as string))
    );

    const consumers = capabilities.filter(cap =>
      cap.operation_patterns.some(p => consumerPatterns.includes(p as string))
    );

    for (const consumer of consumers) {
      for (const producer of producers) {
        if (consumer.id === producer.id) continue;

        const sharedExitPoints = consumer.exit_points.filter(ep =>
          producer.exit_points.includes(ep)
        );

        if (sharedExitPoints.length > 0) {
          dependencies.push({
            from_capability: consumer.id,
            to_capability: producer.id,
            dependency_type: 'shares-data',
            strength: 'common',
            evidence: {
              shared_services: [],
              shared_nodes: sharedExitPoints
            },
            description: `Shares ${sharedExitPoints.length} data sink${sharedExitPoints.length > 1 ? 's' : ''}`
          });
        }
      }
    }
  }

  private buildSemanticDependencies(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): void {
    this.buildResourceBasedDependencies(capabilities, dependencies);
    this.buildPathBasedDependencies(capabilities, dependencies);
  }

  private buildResourceBasedDependencies(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): void {
    const createPatterns = ['create', 'add', 'new', 'register', 'post'];
    const readPatterns = ['list', 'get', 'find', 'search', 'query', 'fetch'];
    const updatePatterns = ['update', 'edit', 'modify', 'patch', 'put'];
    const deletePatterns = ['delete', 'remove', 'destroy', 'cancel'];
    const actionPatterns = ['activate', 'deactivate', 'start', 'stop', 'enable', 'disable'];

    const resourceGroups = new Map<string, Map<string, CASCapability[]>>();

    for (const cap of capabilities) {
      const nameParts = cap.name.toLowerCase().split(/[\s_-]+/);
      if (nameParts.length < 2) continue;

      const action = nameParts[nameParts.length - 1];
      let resource = nameParts.slice(0, -1).join('_');

      resource = this.normalizeResource(resource);

      if (!resourceGroups.has(resource)) {
        resourceGroups.set(resource, new Map());
      }
      const actions = resourceGroups.get(resource)!;

      let actionType = 'other';
      if (createPatterns.includes(action)) actionType = 'create';
      else if (readPatterns.includes(action)) actionType = 'read';
      else if (updatePatterns.includes(action)) actionType = 'update';
      else if (deletePatterns.includes(action)) actionType = 'delete';
      else if (actionPatterns.includes(action)) actionType = 'action';

      if (!actions.has(actionType)) {
        actions.set(actionType, []);
      }
      actions.get(actionType)!.push(cap);
    }

    for (const [resource, actions] of resourceGroups) {
      const createCaps = actions.get('create') || [];
      const readCaps = actions.get('read') || [];
      const updateCaps = actions.get('update') || [];
      const deleteCaps = actions.get('delete') || [];
      const actionCaps = actions.get('action') || [];

      for (const readCap of readCaps) {
        for (const createCap of createCaps) {
          if (readCap.id !== createCap.id) {
            dependencies.push({
              from_capability: readCap.id,
              to_capability: createCap.id,
              dependency_type: 'requires',
              strength: 'common',
              evidence: {
                shared_services: [],
                shared_nodes: []
              },
              description: `Reads ${resource} created by ${createCap.name}`
            });
          }
        }
      }

      for (const updateCap of updateCaps) {
        for (const createCap of createCaps) {
          if (updateCap.id !== createCap.id) {
            dependencies.push({
              from_capability: updateCap.id,
              to_capability: createCap.id,
              dependency_type: 'requires',
              strength: 'common',
              evidence: {
                shared_services: [],
                shared_nodes: []
              },
              description: `Updates ${resource} created by ${createCap.name}`
            });
          }
        }
      }

      for (const deleteCap of deleteCaps) {
        for (const createCap of createCaps) {
          if (deleteCap.id !== createCap.id) {
            dependencies.push({
              from_capability: deleteCap.id,
              to_capability: createCap.id,
              dependency_type: 'requires',
              strength: 'required',
              evidence: {
                shared_services: [],
                shared_nodes: []
              },
              description: `Deletes ${resource} created by ${createCap.name}`
            });
          }
        }
      }

      for (const actionCap of actionCaps) {
        for (const createCap of createCaps) {
          if (actionCap.id !== createCap.id) {
            dependencies.push({
              from_capability: actionCap.id,
              to_capability: createCap.id,
              dependency_type: 'uses',
              strength: 'common',
              evidence: {
                shared_services: [],
                shared_nodes: []
              },
              description: `${actionCap.name} operates on ${resource}`
            });
          }
        }
      }
    }
  }

  private normalizeResource(resource: string): string {
    const singularMap: Record<string, string> = {
      'buildings': 'building',
      'companions': 'companion',
      'enemies': 'enemy',
      'quests': 'quest',
      'regions': 'region',
      'shops': 'shop',
      'npcs': 'npc',
      'arcs': 'arc',
      'organizations': 'organization',
      'roads': 'road',
      'recipes': 'recipe',
      'spells': 'spell',
      'saves': 'save',
      'objects': 'object'
    };
    return singularMap[resource] || resource;
  }

  private buildPathBasedDependencies(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): void {
    const pathToCapabilities = new Map<string, CASCapability[]>();

    for (const cap of capabilities) {
      for (const op of cap.operations) {
        const path = op.trigger?.path || '';
        if (!path) continue;

        const segments = path.split('/').filter(s =>
          s && !s.startsWith('{') && !s.startsWith(':')
        );

        if (segments.length === 0) continue;

        const rootResource = segments[0];
        if (!pathToCapabilities.has(rootResource)) {
          pathToCapabilities.set(rootResource, []);
        }
        const caps = pathToCapabilities.get(rootResource)!;
        if (!caps.includes(cap)) {
          caps.push(cap);
        }

        if (segments.length > 1) {
          const subResource = `${segments[0]}/${segments[1]}`;
          if (!pathToCapabilities.has(subResource)) {
            pathToCapabilities.set(subResource, []);
          }
          const subCaps = pathToCapabilities.get(subResource)!;
          if (!subCaps.includes(cap)) {
            subCaps.push(cap);
          }
        }
      }
    }

    for (const [resource, caps] of pathToCapabilities) {
      if (caps.length < 2) continue;

      const sortedCaps = [...caps].sort((a, b) => {
        const aPath = a.operations[0]?.trigger?.path || '';
        const bPath = b.operations[0]?.trigger?.path || '';
        return aPath.length - bPath.length;
      });

      const parentCap = sortedCaps[0];

      for (let i = 1; i < sortedCaps.length; i++) {
        const childCap = sortedCaps[i];
        if (parentCap.id === childCap.id) continue;

        const parentPath = parentCap.operations[0]?.trigger?.path || '';
        const childPath = childCap.operations[0]?.trigger?.path || '';

        if (childPath.startsWith(parentPath) || parentPath.length < childPath.length) {
          dependencies.push({
            from_capability: childCap.id,
            to_capability: parentCap.id,
            dependency_type: 'uses',
            strength: 'optional',
            evidence: {
              shared_services: [],
              shared_nodes: []
            },
            description: `${childCap.name} is nested under ${parentCap.name} (${resource})`
          });
        }
      }
    }
  }

  private findCapabilityForEntity(
    capabilities: CASCapability[],
    entityName: string
  ): CASCapability | undefined {
    const entityLower = entityName.toLowerCase();

    for (const cap of capabilities) {
      if (cap.entities_touched?.some(e => e.toLowerCase().includes(entityLower))) {
        return cap;
      }

      const capNameLower = cap.name.toLowerCase();
      if (capNameLower.includes(entityLower) || entityLower.includes(capNameLower.replace(/\s+/g, ''))) {
        return cap;
      }
    }

    return undefined;
  }

  private findCapabilitiesForNodes(
    capabilities: CASCapability[],
    nodeIds: string[]
  ): CASCapability[] {
    const result: CASCapability[] = [];

    for (const cap of capabilities) {
      const hasMatchingService = cap.services_used.some(s => nodeIds.includes(s));
      if (hasMatchingService) {
        result.push(cap);
      }
    }

    return result;
  }

  private deduplicateAndRank(
    dependencies: CASCapabilityDependency[]
  ): CASCapabilityDependency[] {
    const uniqueDeps = new Map<string, CASCapabilityDependency>();

    for (const dep of dependencies) {
      const key = `${dep.from_capability}|${dep.to_capability}`;

      if (!uniqueDeps.has(key)) {
        uniqueDeps.set(key, dep);
      } else {
        const existing = uniqueDeps.get(key)!;
        const merged = this.mergeDependencies(existing, dep);
        uniqueDeps.set(key, merged);
      }
    }

    const result = Array.from(uniqueDeps.values());

    const strengthOrder = { required: 0, common: 1, optional: 2 };
    result.sort((a, b) => strengthOrder[a.strength] - strengthOrder[b.strength]);

    return result;
  }

  private mergeDependencies(
    a: CASCapabilityDependency,
    b: CASCapabilityDependency
  ): CASCapabilityDependency {
    const strengthPriority = { required: 2, common: 1, optional: 0 };
    const typePriority = { requires: 4, cascade: 3, triggers: 2, 'shares-data': 1, uses: 0 };

    const strongerStrength = strengthPriority[a.strength] >= strengthPriority[b.strength] ?
      a.strength : b.strength;

    const strongerType = typePriority[a.dependency_type] >= typePriority[b.dependency_type] ?
      a.dependency_type : b.dependency_type;

    const mergedServices = Array.from(new Set([
      ...a.evidence.shared_services,
      ...b.evidence.shared_services
    ]));

    const mergedEntities = Array.from(new Set([
      ...(a.evidence.shared_entities || []),
      ...(b.evidence.shared_entities || [])
    ]));

    const mergedNodes = Array.from(new Set([
      ...a.evidence.shared_nodes,
      ...b.evidence.shared_nodes
    ]));

    const totalCalls = (a.evidence.call_count || 0) + (b.evidence.call_count || 0);

    return {
      from_capability: a.from_capability,
      to_capability: a.to_capability,
      dependency_type: strongerType,
      strength: strongerStrength,
      evidence: {
        shared_services: mergedServices,
        shared_entities: mergedEntities.length > 0 ? mergedEntities : undefined,
        shared_nodes: mergedNodes,
        call_count: totalCalls > 0 ? totalCalls : undefined
      },
      description: this.combineDescriptions(a.description, b.description)
    };
  }

  private combineDescriptions(a: string, b: string): string {
    if (a === b) return a;
    if (a.includes(b)) return a;
    if (b.includes(a)) return b;

    const parts = [a, b].filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];

    return `${a}; ${b}`;
  }
}
