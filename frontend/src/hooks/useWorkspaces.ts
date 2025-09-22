import { useState, useEffect, useCallback } from 'react';
import {
  Workspace,
  WorkspaceAccess,
  WorkspaceStats,
  WorkspaceInvitation,
  InviteUserRequest,
} from '../types/workspace.types';
import { apiService } from '../services/api';

export function useWorkspaceDetails(workspaceId: string | null) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspace = useCallback(async () => {
    if (!workspaceId) return;

    try {
      setIsLoading(true);
      setError(null);

      const [workspaceData, statsData] = await Promise.all([
        apiService.getWorkspace(workspaceId),
        apiService.getWorkspaceStats(workspaceId),
      ]);

      setWorkspace(workspaceData);
      setStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace details');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  return {
    workspace,
    stats,
    isLoading,
    error,
    refreshWorkspace,
  };
}

export function useWorkspaceAccess(workspaceId: string | null) {
  const [access, setAccess] = useState<WorkspaceAccess[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshAccess = useCallback(async () => {
    if (!workspaceId) return;

    try {
      setIsLoading(true);
      setError(null);

      const accessData = await apiService.getWorkspaceAccess(workspaceId);
      setAccess(accessData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace access');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  const inviteUser = useCallback(async (data: InviteUserRequest): Promise<WorkspaceInvitation> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      const invitation = await apiService.inviteUserToWorkspace(workspaceId, data);
      setInvitations(prev => [...prev, invitation]);
      return invitation;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to invite user';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  const updateUserAccess = useCallback(async (userId: string, accessLevel: string): Promise<void> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      const updatedAccess = await apiService.updateWorkspaceAccess(workspaceId, userId, accessLevel);
      setAccess(prev => prev.map(a => a.userId === userId ? updatedAccess : a));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update user access';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  const removeUserAccess = useCallback(async (userId: string): Promise<void> => {
    if (!workspaceId) throw new Error('No workspace selected');

    try {
      setError(null);
      await apiService.removeWorkspaceAccess(workspaceId, userId);
      setAccess(prev => prev.filter(a => a.userId !== userId));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to remove user access';
      setError(errorMessage);
      throw err;
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshAccess();
  }, [refreshAccess]);

  return {
    access,
    invitations,
    isLoading,
    error,
    refreshAccess,
    inviteUser,
    updateUserAccess,
    removeUserAccess,
  };
}

export function useWorkspaceValidation() {
  const validateWorkspaceName = useCallback((name: string): string | null => {
    if (!name.trim()) return 'Workspace name is required';
    if (name.length < 2) return 'Workspace name must be at least 2 characters';
    if (name.length > 50) return 'Workspace name must be less than 50 characters';
    if (!/^[a-zA-Z0-9\s\-_]+$/.test(name)) return 'Workspace name can only contain letters, numbers, spaces, hyphens, and underscores';
    return null;
  }, []);

  const validateWorkspaceDescription = useCallback((description: string): string | null => {
    if (description && description.length > 500) return 'Description must be less than 500 characters';
    return null;
  }, []);

  const validateTags = useCallback((tags: string[]): string | null => {
    if (tags.length > 10) return 'Maximum 10 tags allowed';

    for (const tag of tags) {
      if (tag.length > 20) return 'Each tag must be less than 20 characters';
      if (!/^[a-zA-Z0-9\-_]+$/.test(tag)) return 'Tags can only contain letters, numbers, hyphens, and underscores';
    }

    return null;
  }, []);

  return {
    validateWorkspaceName,
    validateWorkspaceDescription,
    validateTags,
  };
}