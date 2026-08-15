import type {
  CASEntryPoint,
  CASSecurityBoundary,
  CASSecurityContext,
} from '../../types/cas.types';





































export type EntryPointSecurityEnforcement = 'enforced' | 'assumed';

export type EntryPointSecurityResult = NonNullable<CASEntryPoint['security']> & {
  enforcement?: EntryPointSecurityEnforcement;
};






export type EntryPointWithSecurity = Omit<CASEntryPoint, 'security'> & {
  security?: EntryPointSecurityResult;
};




const MECHANISM_METHOD_PATTERNS: Array<{ pattern: RegExp; method: string }> = [
  { pattern: /passport/i, method: 'passport' },
  { pattern: /o?auth\s*2?/i, method: 'oauth' },
  { pattern: /jwt|json\s*web\s*token/i, method: 'jwt' },
  { pattern: /api[\s-]?key/i, method: 'api-key' },
  { pattern: /mtls|mutual\s*tls|client[\s-]?cert/i, method: 'mtls' },
  { pattern: /session/i, method: 'session' },
];





export function deriveAuthMethod(mechanism: string | undefined | null): string {
  if (!mechanism) return 'middleware';
  for (const { pattern, method } of MECHANISM_METHOD_PATTERNS) {
    if (pattern.test(mechanism)) return method;
  }
  return 'middleware';
}



function candidateNodeIds(entryPoint: CASEntryPoint): string[] {
  const ids: string[] = [];
  if (entryPoint.handler?.node_id) ids.push(entryPoint.handler.node_id);
  if (entryPoint.source_node) ids.push(entryPoint.source_node);
  if (Array.isArray(entryPoint.connected_nodes)) {
    for (const id of entryPoint.connected_nodes) {
      if (id) ids.push(id);
    }
  }
  return ids;
}

function dedupe(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

interface MatchEvidence {
  mechanisms: string[];
  confidence: 'enforced' | 'assumed' | 'missing';
  roles: string[];
  permissions: string[];
}








export function attachEntryPointSecurity(
  entryPoints: CASEntryPoint[],
  securityBoundaries: CASSecurityBoundary[] | undefined | null,
  securityContexts: CASSecurityContext[] | undefined | null,
): EntryPointWithSecurity[] {
  const boundaries = securityBoundaries ?? [];
  const contexts = securityContexts ?? [];

  return entryPoints.map((entryPoint) => {
    const candidates = new Set(candidateNodeIds(entryPoint));
    const evidence: MatchEvidence = {
      mechanisms: [],
      confidence: 'missing',
      roles: [],
      permissions: [],
    };
    let matched = false;
    let sawEnforced = false;
    let sawAssumed = false;


    for (const boundary of boundaries) {
      for (const point of boundary.enforcement_points ?? []) {
        if (!point.node_id || !candidates.has(point.node_id)) continue;
        if (point.confidence === 'missing') {



          matched = true;
          continue;
        }
        matched = true;
        if (point.confidence === 'enforced') sawEnforced = true;
        else sawAssumed = true;
        evidence.mechanisms.push(point.mechanism);
      }
    }



    for (const context of contexts) {
      const scope = context.scope;
      const byNodeId = (scope?.node_ids ?? []).some((id) => candidates.has(id));
      const byEntryPointId = (scope?.entry_points ?? []).includes(entryPoint.id);
      if (!byNodeId && !byEntryPointId) continue;

      matched = true;




      sawAssumed = true;

      const authMethods = context.requirements?.authentication?.methods ?? [];
      for (const m of authMethods) evidence.mechanisms.push(m);
      if (authMethods.length === 0 && context.name) {
        evidence.mechanisms.push(context.name);
      }

      const roles = context.requirements?.authorization?.roles ?? [];
      const permissions = context.requirements?.authorization?.permissions ?? [];
      evidence.roles.push(...roles);
      evidence.permissions.push(...permissions);
    }

    if (!matched) {


      return entryPoint;
    }

    evidence.confidence = sawEnforced ? 'enforced' : sawAssumed ? 'assumed' : 'missing';





    const derivedMethods = dedupe(evidence.mechanisms.map((m) => deriveAuthMethod(m)));

    const existing = entryPoint.security;
    const mergedGuards = dedupe([
      ...(existing?.guards ?? []),
      ...evidence.mechanisms,
      ...derivedMethods,
    ]);
    const mergedRoles = dedupe([...(existing?.roles ?? []), ...evidence.roles]);
    const mergedPermissions = dedupe([
      ...(existing?.permissions ?? []),
      ...evidence.permissions,
    ]);
    const mergedAuthorizedRoles = dedupe([
      ...(existing?.authorized_roles ?? []),
      ...evidence.roles,
    ]);




    const hasPositiveEvidence = sawEnforced || sawAssumed;
    const authenticated = existing?.authenticated === true
      ? true
      : hasPositiveEvidence
        ? true
        : existing?.authenticated;

    const newEnforcement: EntryPointSecurityEnforcement | undefined = hasPositiveEvidence
      ? (sawEnforced ? 'enforced' : 'assumed')
      : undefined;
    const existingEnforcement = (existing as EntryPointSecurityResult | undefined)?.enforcement;
    const enforcement = existingEnforcement ?? newEnforcement;

    const security: EntryPointSecurityResult = {
      ...existing,
      ...(authenticated !== undefined ? { authenticated } : {}),
      ...(mergedGuards.length > 0 ? { guards: mergedGuards } : {}),
      ...(mergedRoles.length > 0 ? { roles: mergedRoles } : {}),
      ...(mergedPermissions.length > 0 ? { permissions: mergedPermissions } : {}),
      ...(mergedAuthorizedRoles.length > 0 ? { authorized_roles: mergedAuthorizedRoles } : {}),
      ...(enforcement !== undefined ? { enforcement } : {}),
    };

    return { ...entryPoint, security };
  });
}
