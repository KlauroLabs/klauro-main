import { useState, useEffect, useCallback } from 'react';
import { apiService, ComponentConnectionRecord, ComponentRecord } from '../services/api';

interface ComponentDetail {
  id: string;
  name: string;
  type: string;
  path: string;
  complexity: number;
  connections: number;
  hasChildren?: boolean;
  childCount?: number;
  children?: ComponentSummary[];
}

interface ComponentSummary {
  id: string;
  name: string;
  type: string;
  complexity: number;
  connections: number;
  hasChildren?: boolean;
  childCount?: number;
  children?: ComponentSummary[];
}

interface UseProgressiveDataOptions {
  projectId: string;
  componentId?: string;
  autoLoad?: boolean;
  depth?: number;
}

interface UseProgressiveDataReturn {
  data: ComponentDetail | null;
  children: ComponentSummary[];
  isLoading: boolean;
  error: string | null;
  loadMore: (componentId: string, depth?: number) => Promise<void>;
  expandComponent: (componentId: string) => Promise<void>;
  preload: (componentId: string) => void;
  cacheStats: { entries: number; sizeBytes: number; utilization: number };
}

function getComponentId(value?: ComponentRecord | string): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

function getConnectionFrom(connection: ComponentConnectionRecord): string | undefined {
  return connection.from || connection.source || getComponentId(connection.fromComponent);
}

function getConnectionTo(connection: ComponentConnectionRecord): string | undefined {
  return connection.to || connection.target || getComponentId(connection.toComponent);
}

function getNeighborIds(componentId: string, connections: ComponentConnectionRecord[]): string[] {
  const ids = new Set<string>();

  for (const connection of connections) {
    const from = getConnectionFrom(connection);
    const to = getConnectionTo(connection);

    if (from === componentId && to) {
      ids.add(to);
    } else if (to === componentId && from) {
      ids.add(from);
    }
  }

  return Array.from(ids);
}

function connectionCount(componentId: string, connections: ComponentConnectionRecord[]): number {
  return connections.filter(connection =>
    getConnectionFrom(connection) === componentId || getConnectionTo(connection) === componentId
  ).length;
}

function toSummary(
  component: ComponentRecord,
  connections: ComponentConnectionRecord[],
  children?: ComponentSummary[]
): ComponentSummary {
  const childCount = children?.length || 0;

  return {
    id: component.id,
    name: component.name,
    type: component.type,
    complexity: component.complexity || 0,
    connections: component.connectionCount ?? connectionCount(component.id, connections),
    hasChildren: childCount > 0,
    childCount,
    children,
  };
}

function toDetail(
  component: ComponentRecord,
  connections: ComponentConnectionRecord[],
  children: ComponentSummary[]
): ComponentDetail {
  return {
    ...toSummary(component, connections, children),
    path: component.path || '',
  };
}

function buildChildren(
  componentId: string,
  componentsById: Map<string, ComponentRecord>,
  connections: ComponentConnectionRecord[],
  remainingDepth: number,
  visited: Set<string>
): ComponentSummary[] {
  if (remainingDepth <= 0) {
    return [];
  }

  return getNeighborIds(componentId, connections)
    .filter(id => !visited.has(id))
    .map(id => {
      const component = componentsById.get(id);
      if (!component) {
        return null;
      }

      const childVisited = new Set(visited);
      childVisited.add(id);
      const nestedChildren = buildChildren(id, componentsById, connections, remainingDepth - 1, childVisited);
      return toSummary(component, connections, nestedChildren);
    })
    .filter((summary): summary is ComponentSummary => Boolean(summary));
}

export const useProgressiveData = ({
  projectId: _projectId,
  componentId,
  autoLoad = true,
  depth = 2
}: UseProgressiveDataOptions): UseProgressiveDataReturn => {
  const [data, setData] = useState<ComponentDetail | null>(null);
  const [children, setChildren] = useState<ComponentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState({ entries: 0, sizeBytes: 0, utilization: 0 });

  const loadComponentData = useCallback(async (id: string, loadDepth: number = depth) => {
    setIsLoading(true);
    setError(null);

    try {
      const [components, connections] = await Promise.all([
        apiService.getComponents(),
        apiService.getComponentConnections(id),
      ]);
      const componentsById = new Map(components.map(component => [component.id, component]));
      const component = componentsById.get(id);

      if (!component) {
        throw new Error(`Component not found: ${id}`);
      }

      const loadedChildren = buildChildren(id, componentsById, connections, loadDepth, new Set([id]));
      setData(toDetail(component, connections, loadedChildren));
      setChildren(loadedChildren);

      const sizeBytes = JSON.stringify({ components, connections }).length;
      const entries = components.length + connections.length;
      setCacheStats({ entries, sizeBytes, utilization: entries > 0 ? 1 : 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load component data');
    } finally {
      setIsLoading(false);
    }
  }, [depth]);

  const loadMore = useCallback(async (id: string, loadDepth?: number) => {
    await loadComponentData(id, loadDepth);
  }, [loadComponentData]);

  const expandComponent = useCallback(async (id: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const [components, connections] = await Promise.all([
        apiService.getComponents(),
        apiService.getComponentConnections(id),
      ]);
      const componentsById = new Map(components.map(component => [component.id, component]));
      const component = componentsById.get(id);

      if (!component) {
        throw new Error(`Component not found: ${id}`);
      }

      const expandedChildren = buildChildren(id, componentsById, connections, 1, new Set([id]));
      const expanded = toSummary(component, connections, expandedChildren);

      setChildren(prev => prev.map(child =>
        child.id === id ? expanded : child
      ));

      if (data?.id === id) {
        setData(toDetail(component, connections, expandedChildren));
      }

      const sizeBytes = JSON.stringify({ components, connections }).length;
      const entries = components.length + connections.length;
      setCacheStats({ entries, sizeBytes, utilization: entries > 0 ? 1 : 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to expand component');
    } finally {
      setIsLoading(false);
    }
  }, [data?.id]);

  const preload = useCallback((id: string) => {
    apiService.getComponentConnections(id)
      .then(connections => {
        setCacheStats(prev => ({
          entries: prev.entries + connections.length,
          sizeBytes: prev.sizeBytes + JSON.stringify(connections).length,
          utilization: connections.length > 0 ? 1 : prev.utilization,
        }));
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to preload component');
      });
  }, []);

  useEffect(() => {
    if (autoLoad && componentId) {
      loadComponentData(componentId);
    }
  }, [autoLoad, componentId, loadComponentData]);

  return {
    data,
    children,
    isLoading,
    error,
    loadMore,
    expandComponent,
    preload,
    cacheStats
  };
};
