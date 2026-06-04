import { useState, useEffect, useCallback } from 'react';
import {
  Codebase,
  CreateCodebaseRequest,
  UpdateCodebaseRequest,
} from '../types/workspace.types';
import {
  AnalysisRun,
  AnalysisProgress,
  AnalysisHistoryItem,
  CodebaseComparison,
  AnalysisFilters,
  CreateAnalysisRequest,
  CodebaseContextValue,
  AnalysisResult,
} from '../types/codebase.types';
import { apiService } from '../services/api';

export function useCodebases(workspaceId: string | null) {
  const [codebases, setCodebases] = useState<Codebase[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCodebases = useCallback(async () => {
    if (!workspaceId) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await apiService.getCodebases(workspaceId);
      setCodebases(response.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load codebases');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  const createCodebase = useCallback(async (data: CreateCodebaseRequest): Promise<Codebase> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      const codebase = await apiService.createCodebase(workspaceId, data);
      setCodebases(prev => [...prev, codebase]);
      return codebase;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create codebase';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  const updateCodebase = useCallback(async (codebaseId: string, data: UpdateCodebaseRequest): Promise<Codebase> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      const codebase = await apiService.updateCodebase(workspaceId, codebaseId, data);
      setCodebases(prev => prev.map(c => c.id === codebaseId ? codebase : c));
      return codebase;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update codebase';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  const deleteCodebase = useCallback(async (codebaseId: string): Promise<void> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      await apiService.deleteCodebase(workspaceId, codebaseId);
      setCodebases(prev => prev.filter(c => c.id !== codebaseId));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete codebase';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshCodebases();
  }, [refreshCodebases]);

  return {
    codebases,
    isLoading,
    error,
    refreshCodebases,
    createCodebase,
    updateCodebase,
    deleteCodebase,
  };
}

export function useCodebaseAnalysis(workspaceId: string | null, codebaseId: string | null) {
  const [analyses, setAnalyses] = useState<AnalysisRun[]>([]);
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisRun | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAnalyses = useCallback(async (filters?: AnalysisFilters) => {
    if (!workspaceId || !codebaseId) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await apiService.getAnalyses(workspaceId, codebaseId, filters);
      setAnalyses(response.data);

      // Set current analysis to the most recent completed one
      const completedAnalyses = response.data.filter(a => a.status === 'completed');
      if (completedAnalyses.length > 0) {
        setCurrentAnalysis(completedAnalyses[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analyses');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, codebaseId]);

  const startAnalysis = useCallback(async (config?: CreateAnalysisRequest): Promise<string> => {
    if (!workspaceId || !codebaseId) throw new Error('No workspace or codebase selected');

    try {
      setError(null);
      const result = await apiService.createAnalysis(workspaceId, codebaseId, config || {});
      setAnalyses(prev => [result.analysisRun, ...prev]);
      return result.analysisRun.id;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start analysis';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId, codebaseId]);

  const cancelAnalysis = useCallback(async (analysisId: string): Promise<void> => {
    if (!workspaceId || !codebaseId) throw new Error('No workspace or codebase selected');

    try {
      setError(null);
      await apiService.cancelAnalysis(workspaceId, codebaseId, analysisId);
      setAnalyses(prev => prev.map(a =>
        a.id === analysisId ? { ...a, status: 'cancelled' as const } : a
      ));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to cancel analysis';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId, codebaseId]);

  const getAnalysisProgress = useCallback(async (analysisId: string): Promise<AnalysisProgress | null> => {
    if (!workspaceId || !codebaseId) return null;

    try {
      const progress = await apiService.getAnalysisProgress(workspaceId, codebaseId, analysisId);
      setAnalysisProgress(progress);
      return progress;
    } catch (err) {
      // Progress endpoint might not exist for completed analyses, so don't set error
      return null;
    }
  }, [workspaceId, codebaseId]);

  useEffect(() => {
    refreshAnalyses();
  }, [refreshAnalyses]);

  return {
    analyses,
    currentAnalysis,
    analysisProgress,
    isLoading,
    error,
    refreshAnalyses,
    startAnalysis,
    cancelAnalysis,
    getAnalysisProgress,
    setCurrentAnalysis,
  };
}

export function useAnalysisComparison(workspaceId: string | null, codebaseId: string | null) {
  const [comparison, setComparison] = useState<CodebaseComparison | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compareAnalyses = useCallback(async (baselineId: string, comparisonId: string): Promise<CodebaseComparison> => {
    if (!workspaceId || !codebaseId) throw new Error('No workspace or codebase selected');

    try {
      setIsLoading(true);
      setError(null);
      const result = await apiService.compareAnalyses(workspaceId, codebaseId, baselineId, comparisonId);
      setComparison(result);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to compare analyses';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, codebaseId]);

  const clearComparison = useCallback(() => {
    setComparison(null);
    setError(null);
  }, []);

  return {
    comparison,
    isLoading,
    error,
    compareAnalyses,
    clearComparison,
  };
}

export function useCodebaseValidation() {
  const validateCodebaseName = useCallback((name: string): string | null => {
    if (!name.trim()) return 'Codebase name is required';
    if (name.length < 2) return 'Codebase name must be at least 2 characters';
    if (name.length > 100) return 'Codebase name must be less than 100 characters';
    if (!/^[a-zA-Z0-9\s\-_.]+$/.test(name)) return 'Codebase name can only contain letters, numbers, spaces, hyphens, underscores, and periods';
    return null;
  }, []);

  const validateRepositoryUrl = useCallback((url: string): string | null => {
    if (!url) return null; // Repository URL is optional

    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:', 'git:', 'ssh:'].includes(parsedUrl.protocol)) {
        return 'Repository URL must use http, https, git, or ssh protocol';
      }
    } catch {
      return 'Invalid repository URL format';
    }

    return null;
  }, []);

  const validateDescription = useCallback((description: string): string | null => {
    if (description && description.length > 1000) return 'Description must be less than 1000 characters';
    return null;
  }, []);

  const validateTags = useCallback((tags: string[]): string | null => {
    if (tags.length > 20) return 'Maximum 20 tags allowed';

    for (const tag of tags) {
      if (tag.length > 30) return 'Each tag must be less than 30 characters';
      if (!/^[a-zA-Z0-9\-_]+$/.test(tag)) return 'Tags can only contain letters, numbers, hyphens, and underscores';
    }

    return null;
  }, []);

  return {
    validateCodebaseName,
    validateRepositoryUrl,
    validateDescription,
    validateTags,
  };
}