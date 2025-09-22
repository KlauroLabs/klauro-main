import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import {
  Workspace,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  WorkspaceContextValue,
} from '../types/workspace.types';
import { apiService } from '../services/api';

interface WorkspaceState {
  currentWorkspace: Workspace | null;
  workspaces: Workspace[];
  isLoading: boolean;
  error: string | null;
}

type WorkspaceAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_WORKSPACES'; payload: Workspace[] }
  | { type: 'SET_CURRENT_WORKSPACE'; payload: Workspace | null }
  | { type: 'ADD_WORKSPACE'; payload: Workspace }
  | { type: 'UPDATE_WORKSPACE'; payload: Workspace }
  | { type: 'REMOVE_WORKSPACE'; payload: string };

const initialState: WorkspaceState = {
  currentWorkspace: null,
  workspaces: [],
  isLoading: false,
  error: null,
};

function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload, isLoading: false };

    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.payload, isLoading: false };

    case 'SET_CURRENT_WORKSPACE':
      return { ...state, currentWorkspace: action.payload };

    case 'ADD_WORKSPACE':
      return {
        ...state,
        workspaces: [...state.workspaces, action.payload],
        isLoading: false,
      };

    case 'UPDATE_WORKSPACE': {
      const updatedWorkspaces = state.workspaces.map(w =>
        w.id === action.payload.id ? action.payload : w
      );
      return {
        ...state,
        workspaces: updatedWorkspaces,
        currentWorkspace: state.currentWorkspace?.id === action.payload.id
          ? action.payload
          : state.currentWorkspace,
        isLoading: false,
      };
    }

    case 'REMOVE_WORKSPACE': {
      const filteredWorkspaces = state.workspaces.filter(w => w.id !== action.payload);
      return {
        ...state,
        workspaces: filteredWorkspaces,
        currentWorkspace: state.currentWorkspace?.id === action.payload
          ? null
          : state.currentWorkspace,
        isLoading: false,
      };
    }

    default:
      return state;
  }
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

interface WorkspaceProviderProps {
  children: React.ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const [state, dispatch] = useReducer(workspaceReducer, initialState);

  const refreshWorkspaces = useCallback(async () => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });

      const response = await apiService.getWorkspaces();
      dispatch({ type: 'SET_WORKSPACES', payload: response.data });

      // Set current workspace from localStorage or first workspace
      const savedWorkspaceId = localStorage.getItem('currentWorkspaceId');
      let currentWorkspace = null;

      if (savedWorkspaceId) {
        currentWorkspace = response.data.find(w => w.id === savedWorkspaceId) || null;
      }

      if (!currentWorkspace && response.data.length > 0) {
        currentWorkspace = response.data[0];
      }

      if (currentWorkspace) {
        localStorage.setItem('currentWorkspaceId', currentWorkspace.id);
        dispatch({ type: 'SET_CURRENT_WORKSPACE', payload: currentWorkspace });
      }
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error instanceof Error ? error.message : 'Failed to load workspaces' });
    }
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });

      const workspace = await apiService.getWorkspace(workspaceId);
      localStorage.setItem('currentWorkspaceId', workspace.id);
      dispatch({ type: 'SET_CURRENT_WORKSPACE', payload: workspace });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: error instanceof Error ? error.message : 'Failed to switch workspace' });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  const createWorkspace = useCallback(async (data: CreateWorkspaceRequest): Promise<Workspace> => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });

      // For now, always create personal workspace
      // TODO: Add organization workspace creation logic based on UI selection
      const workspace = await apiService.createPersonalWorkspace(data);

      dispatch({ type: 'ADD_WORKSPACE', payload: workspace });

      // Switch to new workspace
      localStorage.setItem('currentWorkspaceId', workspace.id);
      dispatch({ type: 'SET_CURRENT_WORKSPACE', payload: workspace });

      return workspace;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create workspace';
      dispatch({ type: 'SET_ERROR', payload: errorMessage });
      throw error;
    }
  }, []);

  const updateWorkspace = useCallback(async (id: string, data: UpdateWorkspaceRequest): Promise<Workspace> => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });

      const workspace = await apiService.updateWorkspace(id, data);
      dispatch({ type: 'UPDATE_WORKSPACE', payload: workspace });

      return workspace;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update workspace';
      dispatch({ type: 'SET_ERROR', payload: errorMessage });
      throw error;
    }
  }, []);

  const deleteWorkspace = useCallback(async (id: string): Promise<void> => {
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: null });

      await apiService.deleteWorkspace(id);
      dispatch({ type: 'REMOVE_WORKSPACE', payload: id });

      // If deleted workspace was current, clear it
      if (state.currentWorkspace?.id === id) {
        localStorage.removeItem('currentWorkspaceId');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete workspace';
      dispatch({ type: 'SET_ERROR', payload: errorMessage });
      throw error;
    }
  }, [state.currentWorkspace?.id]);

  // Load workspaces on mount
  useEffect(() => {
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  const contextValue: WorkspaceContextValue = {
    currentWorkspace: state.currentWorkspace,
    workspaces: state.workspaces,
    isLoading: state.isLoading,
    error: state.error,
    switchWorkspace,
    refreshWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };

  return (
    <WorkspaceContext.Provider value={contextValue}>
      {children}
    </WorkspaceContext.Provider>
  );
}