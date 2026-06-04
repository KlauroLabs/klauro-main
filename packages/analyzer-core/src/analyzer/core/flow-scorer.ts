import {
  CASCapability,
  CASDomainConcept,
  SystemPurpose
} from '../../types/cas.types';

const INFRASTRUCTURE_PATTERNS = new Set([
  'health', 'metrics', 'config', 'log', 'logging', 'auth',
  'session', 'cache', 'middleware', 'guard', 'interceptor',
  'filter', 'pipe', 'exception', 'error', 'init', 'setup',
  'bootstrap', 'configure', 'utility', 'helper', 'common',
  'status', 'ping', 'version', 'debug', 'trace'
]);

const SUPPORTING_PATTERNS = new Set([
  'subscription', 'billing', 'payment', 'invoice', 'receipt',
  'email', 'notification', 'alert', 'message', 'sms',
  'webhook', 'callback', 'schedule', 'job', 'queue',
  'audit', 'history', 'archive', 'backup', 'restore',
  'preference', 'setting', 'option', 'flag', 'toggle',
  'link', 'connect', 'disconnect', 'account', 'profile',
  'permission', 'role', 'access', 'invite', 'member'
]);

const HIGH_VALUE_PATTERNS = new Set([
  'analyze', 'process', 'execute', 'run', 'compute', 'calculate',
  'transform', 'generate', 'build', 'compile', 'evaluate',
  'validate', 'verify', 'scan', 'detect', 'extract', 'parse',
  'render', 'export', 'import', 'sync', 'migrate', 'deploy',
  'publish', 'submit', 'approve', 'reject', 'review',
  'trade', 'invest', 'withdraw', 'deposit', 'transfer',
  'trigger', 'autopilot', 'portfolio', 'rebalance', 'allocate',
  'swap', 'exchange', 'convert', 'stake', 'unstake', 'claim',
  'checkout', 'purchase', 'order', 'fulfill', 'ship', 'refund',
  'aggregate', 'summarize', 'report', 'forecast', 'predict',
  'optimize', 'recommend', 'rank', 'score', 'classify'
]);

export class FlowScorer {
  scoreCapabilities(
    capabilities: CASCapability[],
    domainConcepts: CASDomainConcept[],
    systemPurpose?: SystemPurpose
  ): void {
    const coreConcepts = domainConcepts
      .filter(c => c.classification === 'core')
      .map(c => c.name.toLowerCase());

    for (const cap of capabilities) {
      const signals = {
        domain_concept_score: this.scoreDomainAlignment(cap, coreConcepts),
        centrality_score: 0,
        coverage_score: this.scoreCoverage(cap),
        complexity_score: this.scoreComplexity(cap),
        total_score: 0
      };

      cap.signals = signals;
    }

    this.scoreCentrality(capabilities);

    for (const cap of capabilities) {
      cap.signals.total_score =
        cap.signals.domain_concept_score * 0.40 +
        cap.signals.centrality_score * 0.30 +
        cap.signals.coverage_score * 0.15 +
        cap.signals.complexity_score * 0.15;
    }

    this.classifyCapabilities(capabilities);
  }

  private scoreDomainAlignment(cap: CASCapability, coreConcepts: string[]): number {
    const name = cap.name.toLowerCase();
    let score = 0;

    for (const concept of coreConcepts) {
      if (name.includes(concept) || concept.includes(name.replace(/\s+/g, ''))) {
        score += 30;
        break;
      }
    }

    const nameParts = name.split(/[\s\-_]+/);
    for (const part of nameParts) {
      if (HIGH_VALUE_PATTERNS.has(part)) {
        score += 35;
        break;
      }
    }

    const actionOps = cap.operations.filter(o => o.pattern === 'action');
    score += Math.min(actionOps.length * 15, 30);

    const actionPatterns = cap.operation_patterns || [];
    if (actionPatterns.includes('command') || actionPatterns.includes('transform')) {
      score += 15;
    }
    if (actionPatterns.includes('pipeline')) {
      score += 20;
    }

    for (const part of nameParts) {
      if (INFRASTRUCTURE_PATTERNS.has(part)) {
        score -= 35;
        break;
      }
    }

    for (const part of nameParts) {
      if (SUPPORTING_PATTERNS.has(part)) {
        score -= 20;
        break;
      }
    }

    const hasCrudOnly = actionPatterns.includes('crud') &&
      !actionPatterns.includes('command') &&
      !actionPatterns.includes('transform') &&
      !actionPatterns.includes('pipeline') &&
      actionOps.length === 0;

    if (hasCrudOnly) {
      score -= 15;
    }

    if (cap.entry_point_summary.primary_type === 'http' && actionPatterns.includes('crud')) {
      score += 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  private scoreCentrality(capabilities: CASCapability[]): void {
    for (const cap of capabilities) {
      let centralityScore = 0;

      const dependedByCount = cap.depended_by?.length || 0;
      centralityScore += dependedByCount * 25;

      const requiresDeps = cap.depends_on?.filter(d =>
        d.dependency_type === 'requires' && d.strength === 'required'
      ) || [];
      centralityScore += Math.min(requiresDeps.length * 10, 30);

      const serviceUsageCount = new Map<string, number>();
      for (const otherCap of capabilities) {
        if (otherCap.id === cap.id) continue;
        for (const service of otherCap.services_used) {
          if (cap.services_used.includes(service)) {
            serviceUsageCount.set(service, (serviceUsageCount.get(service) || 0) + 1);
          }
        }
      }

      const sharedServicesScore = Math.min(serviceUsageCount.size * 5, 20);
      centralityScore += sharedServicesScore;

      cap.signals.centrality_score = Math.min(100, centralityScore);
    }
  }

  private scoreCoverage(cap: CASCapability): number {
    let score = 0;

    const epCount = cap.entry_points.length;
    if (epCount === 1) {
      score += 20;
    } else if (epCount <= 3) {
      score += 25;
    } else {
      score += 30;
    }

    const actionOps = cap.operations.filter(o => o.pattern === 'action');
    score += Math.min(actionOps.length * 20, 40);

    const typeCount = cap.entry_point_summary.types.length;
    if (typeCount > 1) {
      score += 10;
    }

    if (cap.exit_points.length > 0) {
      score += 10;
    }

    const patterns = cap.operation_patterns || [];
    if (patterns.includes('transform') || patterns.includes('pipeline')) {
      score += 10;
    }

    return Math.min(100, score);
  }

  private scoreComplexity(cap: CASCapability): number {
    const profile = cap.complexity_profile;
    let score = 0;

    if (profile.avg_depth >= 2 && profile.avg_depth <= 10) {
      score += 30;
    } else if (profile.avg_depth > 10) {
      score += 15;
    } else if (profile.avg_depth >= 1) {
      score += 20;
    }

    if (profile.has_database_calls && profile.has_external_calls) {
      score += 25;
    } else if (profile.has_database_calls) {
      score += 15;
    } else if (profile.has_external_calls) {
      score += 15;
    }

    if (profile.has_async_calls) {
      score += 10;
    }

    if (profile.branching_factor >= 1.5 && profile.branching_factor <= 4) {
      score += 20;
    } else if (profile.branching_factor > 4) {
      score += 10;
    }

    return Math.min(100, score);
  }

  private classifyCapabilities(capabilities: CASCapability[]): void {
    if (capabilities.length === 0) return;

    const sorted = [...capabilities].sort((a, b) =>
      b.signals.total_score - a.signals.total_score
    );

    const primaryCutoff = Math.max(1, Math.ceil(sorted.length * 0.25));
    const supportingCutoff = Math.max(2, Math.ceil(sorted.length * 0.65));

    const PRIMARY_MIN_SCORE = 35;
    const SUPPORTING_MIN_SCORE = 20;

    for (let i = 0; i < sorted.length; i++) {
      const cap = sorted[i];
      const capNameLower = cap.name.toLowerCase();
      const nameParts = capNameLower.split(/[\s\-_]+/);

      const isInfrastructure = nameParts.some(part => INFRASTRUCTURE_PATTERNS.has(part));
      const isSupporting = nameParts.some(part => SUPPORTING_PATTERNS.has(part));

      const actionPatterns = cap.operation_patterns || [];
      const hasCrudOnly = actionPatterns.includes('crud') &&
        !actionPatterns.includes('command') &&
        !actionPatterns.includes('transform') &&
        !actionPatterns.includes('pipeline') &&
        cap.operations.filter(o => o.pattern === 'action').length === 0;

      if (isInfrastructure) {
        cap.classification = 'infrastructure';
        cap.criticality = 'low';
      } else if (isSupporting && cap.signals.total_score < 70) {
        cap.classification = 'supporting';
        cap.criticality = 'medium';
      } else if (i < primaryCutoff && cap.signals.total_score >= PRIMARY_MIN_SCORE && !hasCrudOnly) {
        cap.classification = 'primary';
        cap.criticality = cap.signals.total_score > 60 ? 'critical' : 'high';
      } else if (i < supportingCutoff || cap.signals.total_score >= SUPPORTING_MIN_SCORE) {
        cap.classification = 'supporting';
        cap.criticality = 'medium';
      } else {
        cap.classification = 'infrastructure';
        cap.criticality = 'low';
      }
    }

    this.adjustClassificationsByDependencies(capabilities);
  }

  private adjustClassificationsByDependencies(capabilities: CASCapability[]): void {
    const primaryCaps = capabilities.filter(c => c.classification === 'primary');

    for (const cap of capabilities) {
      if (cap.classification === 'infrastructure') {
        const dependedByPrimary = primaryCaps.some(primary =>
          primary.services_used.some(s => cap.services_used.includes(s)) &&
          primary.id !== cap.id
        );

        if (dependedByPrimary && cap.signals.total_score > 30) {
          cap.classification = 'supporting';
          cap.criticality = 'medium';
        }
      }
    }
  }

  getTopCapabilities(capabilities: CASCapability[], count: number = 5): CASCapability[] {
    return [...capabilities]
      .sort((a, b) => b.signals.total_score - a.signals.total_score)
      .slice(0, count);
  }

  getPrimaryCapabilities(capabilities: CASCapability[]): CASCapability[] {
    return capabilities.filter(c => c.classification === 'primary');
  }

  getSupportingCapabilities(capabilities: CASCapability[]): CASCapability[] {
    return capabilities.filter(c => c.classification === 'supporting');
  }

  getInfrastructureCapabilities(capabilities: CASCapability[]): CASCapability[] {
    return capabilities.filter(c => c.classification === 'infrastructure');
  }
}
