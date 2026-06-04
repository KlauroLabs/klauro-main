import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BillingTier,
  BillingLimits,
  BillingUsage,
  BillingUpgradeContext,
  BILLING_LIMITS,
  getBillingUpgradeContext,
} from '../types/billing.types';
import { User } from '../types/workspace.types';
import { apiService } from '../services/api';

export function useBilling(user: User | null) {
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    if (!user) return;

    try {
      setIsLoading(true);
      setError(null);
      const usageData = await apiService.getBillingUsage();
      setUsage(usageData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing usage');
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  const limits = useMemo(() => {
    return user ? BILLING_LIMITS[user.billingTier as BillingTier] : null;
  }, [user?.billingTier]);

  const upgradeContext = useMemo(() => {
    if (!user || !usage) return null;
    return getBillingUpgradeContext(user.billingTier as BillingTier, usage);
  }, [user, usage]);

  return {
    usage,
    limits,
    upgradeContext,
    isLoading,
    error,
    refreshUsage,
  };
}

export function useBillingLimits(tier: BillingTier): BillingLimits {
  return useMemo(() => BILLING_LIMITS[tier], [tier]);
}

export function useBillingChecks(
  tier: BillingTier,
  usage: BillingUsage | null
) {
  const limits = useBillingLimits(tier);

  const checks = useMemo(() => {
    if (!usage) {
      return {
        canCreateWorkspace: true,
        canCreateCodebase: true,
        canRunAnalysis: true,
        canUploadFile: true,
        canInviteUser: true,
        workspaceUsage: 0,
        codebaseUsage: 0,
        analysisUsage: 0,
        storageUsage: 0,
        userUsage: 0,
      };
    }

    const canCreateWorkspace = limits.max_workspaces === -1 || usage.current_workspaces < limits.max_workspaces;
    const canCreateCodebase = limits.max_codebases_per_workspace === -1 || usage.current_codebases < limits.max_codebases_per_workspace;
    const canRunAnalysis = limits.max_analyses_per_month === -1 || usage.analyses_this_month < limits.max_analyses_per_month;
    const canUploadFile = limits.max_storage_gb === -1 || usage.storage_used_gb < limits.max_storage_gb;
    const canInviteUser = limits.max_users_per_workspace === -1 || usage.current_users < limits.max_users_per_workspace;

    const workspaceUsage = limits.max_workspaces === -1 ? 0 : (usage.current_workspaces / limits.max_workspaces) * 100;
    const codebaseUsage = limits.max_codebases_per_workspace === -1 ? 0 : (usage.current_codebases / limits.max_codebases_per_workspace) * 100;
    const analysisUsage = limits.max_analyses_per_month === -1 ? 0 : (usage.analyses_this_month / limits.max_analyses_per_month) * 100;
    const storageUsage = limits.max_storage_gb === -1 ? 0 : (usage.storage_used_gb / limits.max_storage_gb) * 100;
    const userUsage = limits.max_users_per_workspace === -1 ? 0 : (usage.current_users / limits.max_users_per_workspace) * 100;

    return {
      canCreateWorkspace,
      canCreateCodebase,
      canRunAnalysis,
      canUploadFile,
      canInviteUser,
      workspaceUsage,
      codebaseUsage,
      analysisUsage,
      storageUsage,
      userUsage,
    };
  }, [limits, usage]);

  return checks;
}

export function useFeatureAccess(tier: BillingTier) {
  const limits = useBillingLimits(tier);

  return useMemo(() => ({
    hasApiAccess: limits.features.api_access,
    hasWebhooks: limits.features.webhooks,
    hasSSO: limits.features.sso,
    hasAdvancedAnalytics: limits.features.advanced_analytics,
    hasPrioritySupport: limits.features.priority_support,
    hasCustomIntegrations: limits.features.custom_integrations,
  }), [limits.features]);
}

export function useBillingWarnings(
  tier: BillingTier,
  usage: BillingUsage | null,
  thresholds = { warning: 80, critical: 95 }
) {
  const checks = useBillingChecks(tier, usage);

  const warnings = useMemo(() => {
    const warnings: Array<{
      type: 'warning' | 'critical';
      resource: string;
      message: string;
      usage: number;
    }> = [];

    const resources = [
      { key: 'workspaceUsage', name: 'Workspaces', action: 'create workspaces' },
      { key: 'codebaseUsage', name: 'Codebases', action: 'add codebases' },
      { key: 'analysisUsage', name: 'Monthly analyses', action: 'run analyses' },
      { key: 'storageUsage', name: 'Storage', action: 'upload files' },
      { key: 'userUsage', name: 'Users', action: 'invite users' },
    ] as const;

    for (const resource of resources) {
      const usage = checks[resource.key];
      if (usage >= thresholds.critical) {
        warnings.push({
          type: 'critical',
          resource: resource.name,
          message: `You've reached ${usage.toFixed(0)}% of your ${resource.name.toLowerCase()} limit. You cannot ${resource.action} until you upgrade your plan.`,
          usage,
        });
      } else if (usage >= thresholds.warning) {
        warnings.push({
          type: 'warning',
          resource: resource.name,
          message: `You've used ${usage.toFixed(0)}% of your ${resource.name.toLowerCase()} limit. Consider upgrading your plan.`,
          usage,
        });
      }
    }

    return warnings.sort((a, b) => b.usage - a.usage);
  }, [checks, thresholds]);

  return warnings;
}

export function useOnboardingProgress(user: User | null) {
  const steps = useMemo(() => [
    {
      id: 'workspace_created',
      title: 'Create your first workspace',
      description: 'Set up a workspace to organize your codebases',
      completed: user ? ['workspace_created', 'first_codebase_added', 'first_analysis_complete', 'completed'].includes(user.onboardingState) : false,
    },
    {
      id: 'first_codebase_added',
      title: 'Add your first codebase',
      description: 'Connect a repository or upload code for analysis',
      completed: user ? ['first_codebase_added', 'first_analysis_complete', 'completed'].includes(user.onboardingState) : false,
    },
    {
      id: 'first_analysis_complete',
      title: 'Complete your first analysis',
      description: 'Run analysis to generate architecture insights',
      completed: user ? ['first_analysis_complete', 'completed'].includes(user.onboardingState) : false,
    },
    {
      id: 'completed',
      title: 'Explore advanced features',
      description: 'Discover collaboration, monitoring, and integration features',
      completed: user?.onboardingState === 'completed',
    },
  ], [user?.onboardingState]);

  const currentStep = useMemo(() => {
    return steps.find(step => !step.completed) || steps[steps.length - 1];
  }, [steps]);

  const progress = useMemo(() => {
    const completedSteps = steps.filter(step => step.completed).length;
    return (completedSteps / steps.length) * 100;
  }, [steps]);

  return {
    steps,
    currentStep,
    progress,
    isCompleted: user?.onboardingState === 'completed',
  };
}