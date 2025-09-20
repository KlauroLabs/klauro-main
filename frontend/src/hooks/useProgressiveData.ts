import { useState, useEffect, useCallback } from 'react';

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

export const useProgressiveData = ({
  projectId,
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
      // Mock data - replace with actual API call
      const componentData: ComponentDetail = {
        id,
        name: `Component ${id}`,
        type: 'component',
        path: `/src/components/${id}.tsx`,
        complexity: Math.floor(Math.random() * 100),
        connections: Math.floor(Math.random() * 20),
        hasChildren: true,
        childCount: Math.floor(Math.random() * 10),
        children: []
      };
      setData(componentData);
      setChildren(componentData.children || []);
      setCacheStats({ entries: 1, sizeBytes: 1024, utilization: 0.5 });
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
    try {
      // Mock expanded data
      const expandedData: ComponentDetail = {
        id,
        name: `Expanded ${id}`,
        type: 'expanded',
        path: `/src/expanded/${id}.tsx`,
        complexity: Math.floor(Math.random() * 100),
        connections: Math.floor(Math.random() * 20),
        hasChildren: false,
        childCount: 0,
        children: []
      };
      setChildren(prev => prev.map(child =>
        child.id === id ? { ...child, ...expandedData } : child
      ));
      setCacheStats({ entries: 2, sizeBytes: 2048, utilization: 0.6 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to expand component');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const preload = useCallback((id: string) => {
    // Mock preload - in real implementation this would cache data
    setCacheStats(prev => ({ ...prev, entries: prev.entries + 1 }));
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