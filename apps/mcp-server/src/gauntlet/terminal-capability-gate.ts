






















































export interface RepoCapabilityFacts {







  repoId: string;






  capabilities: Array<{ name: string; category?: string; entities?: string[] }>;





  declaredTypeNames: string[];
}

export interface ComposedCapability {
  name: string;
  category?: string;
  fromRepoId: string;
}

export interface TerminalCapabilityGateResult {
  pass: boolean;

  substrateRepoIds: string[];

  terminalRepoIds: string[];
  composedCapabilities: ComposedCapability[];
  violations: string[];
}

const IDENTITY_AUTH_SHAPE =
  /\b(log[- ]?in|sign[- ]?up|authenticat\w*|password|credential|session[- ]?token|user\s+ident(?:ity|ities)|register\s+user|user\s+account|\bsso\b|\boauth\b)\b/i;

function anchoringTypes(repo: RepoCapabilityFacts): Set<string> {
  const out = new Set<string>();
  for (const cap of repo.capabilities) {
    for (const e of cap.entities ?? []) out.add(e);
  }
  return out;
}







export function findSubstrateRepoIds(repos: RepoCapabilityFacts[]): Set<string> {
  const substrate = new Set<string>();
  const anchors = new Map<string, Set<string>>();
  for (const r of repos) anchors.set(r.repoId, anchoringTypes(r));

  for (const producer of repos) {
    const ownAnchors = anchors.get(producer.repoId)!;
    if (ownAnchors.size === 0) continue;
    const dependedOnElsewhere = repos.some(consumer => {
      if (consumer.repoId === producer.repoId) return false;
      const consumerAnchors = anchors.get(consumer.repoId)!;
      return consumer.declaredTypeNames.some(
        t => ownAnchors.has(t) && !consumerAnchors.has(t),
      );
    });
    if (dependedOnElsewhere) substrate.add(producer.repoId);
  }
  return substrate;
}








export function composeParentCapabilities(repos: RepoCapabilityFacts[]): ComposedCapability[] {
  const substrate = findSubstrateRepoIds(repos);
  const composed: ComposedCapability[] = [];
  for (const repo of repos) {
    if (substrate.has(repo.repoId)) continue;
    for (const cap of repo.capabilities) {
      composed.push({ name: cap.name, category: cap.category, fromRepoId: repo.repoId });
    }
  }
  return composed;
}








export function runTerminalCapabilityGate(repos: RepoCapabilityFacts[]): TerminalCapabilityGateResult {
  const substrate = findSubstrateRepoIds(repos);
  const composed = composeParentCapabilities(repos);
  const violations = composed
    .filter(c => IDENTITY_AUTH_SHAPE.test(c.name))
    .map(
      c =>
        `"${c.name}" (from ${c.fromRepoId}) reads as identity/auth-shaped but survived composition into the parent capability list`,
    );
  return {
    pass: violations.length === 0,
    substrateRepoIds: Array.from(substrate),
    terminalRepoIds: repos.map(r => r.repoId).filter(id => !substrate.has(id)),
    composedCapabilities: composed,
    violations,
  };
}
