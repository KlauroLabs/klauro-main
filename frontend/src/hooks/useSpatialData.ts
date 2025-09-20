import { useState, useEffect } from 'react';
import { apiService, CASAnalysisResponse } from '../services/api';

export interface ArchitectureNode {
  id: string;
  name: string;
  type: string;
  level: number;
  level_name: string;
  source: {
    file: string;
    line: number;
    end_line: number;
  };
  metadata: Record<string, any>;
}

export interface ArchitectureLink {
  source: string;
  target: string;
  type: string;
  weight?: number;
}

export interface ProgressiveLevel {
  level: number;
  name: string;
  description: string;
  node_count: number;
  recommended_for: string[];
  example_nodes: string[];
  time_to_understand: string;
}

export interface ArchitectureData {
  analysis_id: string;
  analysis_timestamp: string;
  system: {
    id: string;
    name: string;
    type: string;
    root_path: string;
    technologies?: {
      languages?: Array<{ name: string; percentage: number }>;
      frameworks?: Array<{ name: string; confidence: number }>;
    };
    quality?: {
      documentation_coverage?: number;
      test_coverage?: number;
      complexity_score?: number;
    };
  };
  nodes: ArchitectureNode[];
  links: ArchitectureLink[];
  progressive_levels?: {
    total_levels: number;
    level_definitions?: ProgressiveLevel[];
  };
  categories?: Record<string, any>;
  entry_points?: any[];
  exit_points?: any[];
  analyzer_contributions: Array<{
    analyzer_name: string;
    analyzer_type: string;
    confidence: number;
  }>;
}

export function useCASAnalysis(repoPath?: string, initialLevel?: number) {
  const [data, setData] = useState<ArchitectureData | null>(null);
  const [filteredData, setFilteredData] = useState<ArchitectureData | null>(null);
  const [currentLevel, setCurrentLevel] = useState<number>(initialLevel || 1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyzeRepository = async (path: string, level?: number) => {
    if (!path) return;

    setLoading(true);
    setError(null);

    try {
      const response = await apiService.analyzeCAS({
        projectPath: path,
        options: {
          includeTests: true,
          maxDepth: 10,
        },
      });

      const architectureData: ArchitectureData = {
        analysis_id: response.analysis_id,
        analysis_timestamp: response.analysis_timestamp,
        system: response.system,
        nodes: response.nodes,
        links: response.edges || [],
        progressive_levels: { total_levels: 0, level_definitions: [] },
        categories: [],
        entry_points: [],
        exit_points: [],
        analyzer_contributions: response.analyzer_contributions || [],
      };

      setData(architectureData);
      filterDataByLevel(architectureData, level || currentLevel);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const filterDataByLevel = (sourceData: ArchitectureData, level: number) => {
    const filteredNodes = sourceData.nodes.filter(node =>
      node.level === undefined || node.level <= level
    );

    const nodeIds = new Set(filteredNodes.map(n => n.id));
    const filteredLinks = sourceData.links.filter(link =>
      nodeIds.has(link.source) && nodeIds.has(link.target)
    );

    setFilteredData({
      ...sourceData,
      nodes: filteredNodes,
      links: filteredLinks,
    });
  };

  const changeLevel = (newLevel: number) => {
    setCurrentLevel(newLevel);
    if (data) {
      filterDataByLevel(data, newLevel);
    }
  };

  useEffect(() => {
    if (repoPath) {
      analyzeRepository(repoPath, currentLevel);
    }
  }, [repoPath]);

  useEffect(() => {
    if (data) {
      filterDataByLevel(data, currentLevel);
    }
  }, [currentLevel]);

  return {
    data: filteredData || data,
    fullData: data,
    loading,
    error,
    currentLevel,
    changeLevel,
    analyzeRepository,
    progressiveLevels: data?.progressive_levels,
  };
}

export function useDetectedAnalyzers(repoPath?: string) {
  const [analyzers, setAnalyzers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoPath) return;

    const detectAnalyzers = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await apiService.getDetectedAnalyzers(repoPath);
        setAnalyzers(response.analyzers);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analyzer detection failed');
      } finally {
        setLoading(false);
      }
    };

    detectAnalyzers();
  }, [repoPath]);

  return { analyzers, loading, error };
}