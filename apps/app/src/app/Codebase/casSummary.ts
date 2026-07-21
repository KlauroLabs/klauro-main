import type { AnalysisSummary, ConceptualCapability, ProductMapCapability } from '@/shared/api/index';

export interface ArchitecturalPatternSummary {
  name: string;
  confidence?: number;
  category?: string;
}

export interface ArchitectureSummaryFields {
  system_type?: string | null;
  total_files?: number;
  layers?: string[];
  architectural_patterns?: ArchitecturalPatternSummary[];
  architectural_inventory?: Record<string, unknown[]>;
  pattern_balance?: Record<string, number> | null;
}

export interface ExtendedAnalysisSummary extends AnalysisSummary {
  analysis_timestamp?: string | null;
  architecture_type?: string | null;
  architectural_patterns?: ArchitecturalPatternSummary[];
  architectural_inventory_counts?: Record<string, number>;
  pattern_balance?: Record<string, number> | null;
  architecture_summary?: ArchitectureSummaryFields | null;
  nodes_by_type?: Record<string, number>;
  entry_points_by_type?: Record<string, number>;
  database_entities?: string[];
}

export function asExtendedSummary(summary: AnalysisSummary | undefined): ExtendedAnalysisSummary | undefined {
  return summary as ExtendedAnalysisSummary | undefined;
}

export interface MergedCapability {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  criticality?: string;
  entityCount?: number;
  flowCount?: number;
  relatedFlows: ConceptualCapability['related_flows'];
}

export function mergeCapabilities(
  productMapCapabilities: ProductMapCapability[] | undefined,
  conceptualCapabilities: ConceptualCapability[] | undefined,
): MergedCapability[] {
  const conceptualByName = new Map<string, ConceptualCapability>();
  for (const c of conceptualCapabilities || []) conceptualByName.set(c.name.trim().toLowerCase(), c);

  const seen = new Set<string>();
  const merged: MergedCapability[] = [];

  for (const pm of productMapCapabilities || []) {
    const key = pm.name.trim().toLowerCase();
    seen.add(key);
    const conceptual = conceptualByName.get(key);
    merged.push({
      id: conceptual?.id,
      name: pm.name,
      description: pm.description,
      category: pm.category,
      criticality: pm.criticality,
      entityCount: pm.entities?.length,
      flowCount: conceptual?.related_flows?.length,
      relatedFlows: conceptual?.related_flows,
    });
  }

  for (const c of conceptualCapabilities || []) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    merged.push({
      id: c.id,
      name: c.name,
      category: c.category,
      criticality: c.criticality,
      flowCount: c.related_flows?.length,
      relatedFlows: c.related_flows,
    });
  }

  return merged;
}

export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatCompactNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}
