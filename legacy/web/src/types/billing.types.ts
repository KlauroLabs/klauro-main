export type BillingTier = 'free' | 'starter' | 'professional' | 'enterprise';

export type OnboardingState =
  | 'not_started'
  | 'workspace_created'
  | 'first_codebase_added'
  | 'first_analysis_complete'
  | 'completed';

export interface BillingLimits {
  max_workspaces: number;
  max_codebases_per_workspace: number;
  max_users_per_workspace: number;
  max_analyses_per_month: number;
  max_storage_gb: number;
  max_file_size_mb: number;
  retention_days: number;
  features: {
    api_access: boolean;
    webhooks: boolean;
    sso: boolean;
    advanced_analytics: boolean;
    priority_support: boolean;
    custom_integrations: boolean;
  };
}

export interface BillingUsage {
  current_workspaces: number;
  current_codebases: number;
  current_users: number;
  analyses_this_month: number;
  storage_used_gb: number;
  billing_period_start: string;
  billing_period_end: string;
}

export interface BillingPlan {
  tier: BillingTier;
  name: string;
  description: string;
  price_monthly_usd: number;
  price_yearly_usd: number;
  limits: BillingLimits;
  featured_benefits: string[];
}

export const BILLING_LIMITS: Record<BillingTier, BillingLimits> = {
  free: {
    max_workspaces: 1,
    max_codebases_per_workspace: 3,
    max_users_per_workspace: 1,
    max_analyses_per_month: 10,
    max_storage_gb: 1,
    max_file_size_mb: 10,
    retention_days: 30,
    features: {
      api_access: false,
      webhooks: false,
      sso: false,
      advanced_analytics: false,
      priority_support: false,
      custom_integrations: false,
    },
  },
  starter: {
    max_workspaces: 3,
    max_codebases_per_workspace: 10,
    max_users_per_workspace: 5,
    max_analyses_per_month: 100,
    max_storage_gb: 10,
    max_file_size_mb: 50,
    retention_days: 90,
    features: {
      api_access: false,
      webhooks: false,
      sso: false,
      advanced_analytics: false,
      priority_support: false,
      custom_integrations: false,
    },
  },
  professional: {
    max_workspaces: 10,
    max_codebases_per_workspace: 50,
    max_users_per_workspace: 10,
    max_analyses_per_month: 500,
    max_storage_gb: 50,
    max_file_size_mb: 100,
    retention_days: 365,
    features: {
      api_access: true,
      webhooks: true,
      sso: false,
      advanced_analytics: true,
      priority_support: true,
      custom_integrations: false,
    },
  },
  enterprise: {
    max_workspaces: -1, // unlimited
    max_codebases_per_workspace: -1, // unlimited
    max_users_per_workspace: -1, // unlimited
    max_analyses_per_month: -1, // unlimited
    max_storage_gb: -1, // unlimited
    max_file_size_mb: 1000,
    retention_days: -1, // unlimited
    features: {
      api_access: true,
      webhooks: true,
      sso: true,
      advanced_analytics: true,
      priority_support: true,
      custom_integrations: true,
    },
  },
};

export const BILLING_PLANS: BillingPlan[] = [
  {
    tier: 'free',
    name: 'Free',
    description: 'Perfect for personal projects and getting started',
    price_monthly_usd: 0,
    price_yearly_usd: 0,
    limits: BILLING_LIMITS.free,
    featured_benefits: [
      '1 workspace',
      '3 codebases',
      '10 analyses per month',
      '1GB storage',
      'Community support',
    ],
  },
  {
    tier: 'starter',
    name: 'Starter',
    description: 'Great for small teams and growing projects',
    price_monthly_usd: 15,
    price_yearly_usd: 150,
    limits: BILLING_LIMITS.starter,
    featured_benefits: [
      '3 workspaces',
      '10 codebases per workspace',
      '100 analyses per month',
      '10GB storage',
      'Email support',
    ],
  },
  {
    tier: 'professional',
    name: 'Professional',
    description: 'Ideal for teams and professional development',
    price_monthly_usd: 49,
    price_yearly_usd: 490,
    limits: BILLING_LIMITS.professional,
    featured_benefits: [
      '10 workspaces',
      '50 codebases per workspace',
      '500 analyses per month',
      '50GB storage',
      'API access & webhooks',
      'Advanced analytics',
      'Priority support',
    ],
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'For large organizations with advanced needs',
    price_monthly_usd: 199,
    price_yearly_usd: 1990,
    limits: BILLING_LIMITS.enterprise,
    featured_benefits: [
      'Unlimited workspaces',
      'Unlimited codebases',
      'Unlimited analyses',
      'Unlimited storage',
      'SSO integration',
      'Custom integrations',
      'Dedicated support',
    ],
  },
];

export interface BillingUpgradeContext {
  currentTier: BillingTier;
  usage: BillingUsage;
  limits: BillingLimits;
  canUpgrade: boolean;
  suggestedTier?: BillingTier;
  blockedActions: string[];
}

export function getBillingUpgradeContext(
  tier: BillingTier,
  usage: BillingUsage
): BillingUpgradeContext {
  const limits = BILLING_LIMITS[tier];
  const blockedActions: string[] = [];

  let canUpgrade = tier !== 'enterprise';
  let suggestedTier: BillingTier | undefined;

  if (limits.max_workspaces !== -1 && usage.current_workspaces >= limits.max_workspaces) {
    blockedActions.push('Create new workspace');
    if (tier === 'free') suggestedTier = 'starter';
  }

  if (limits.max_codebases_per_workspace !== -1 && usage.current_codebases >= limits.max_codebases_per_workspace) {
    blockedActions.push('Add more codebases');
    if (tier === 'free') suggestedTier = 'starter';
  }

  if (limits.max_analyses_per_month !== -1 && usage.analyses_this_month >= limits.max_analyses_per_month) {
    blockedActions.push('Run additional analyses this month');
    if (tier === 'free') suggestedTier = 'starter';
  }

  if (limits.max_storage_gb !== -1 && usage.storage_used_gb >= limits.max_storage_gb) {
    blockedActions.push('Upload more files');
    if (tier === 'free') suggestedTier = 'starter';
  }

  return {
    currentTier: tier,
    usage,
    limits,
    canUpgrade,
    suggestedTier,
    blockedActions,
  };
}

export function formatStorageSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatPrice(price: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
}