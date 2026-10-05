export interface LinkKindCount {
  detected: number;
  linked: number;
}

export interface EngineLinkCoverage {
  project: string;
  http: LinkKindCount;
  process: LinkKindCount;
  ipc: LinkKindCount;
  unlinked?: string[];
}

export interface SubProjectLinkCoverage {
  sub_project: string;
  detected: number;
  linked: number;
  unlinked_count: number;
  by_kind: { http: LinkKindCount; process: LinkKindCount; ipc: LinkKindCount };
  unlinked: string[];
}

const UNLINKED_SAMPLE = 5;

export function linkCoverageOf(
  links: EngineLinkCoverage[] | undefined,
  nameOf: (project: string) => string,
): SubProjectLinkCoverage[] | undefined {
  if (!links || links.length === 0) return undefined;
  return links.map(held => {
    const kinds = { http: held.http, process: held.process, ipc: held.ipc };
    const detected = kinds.http.detected + kinds.process.detected + kinds.ipc.detected;
    const linked = kinds.http.linked + kinds.process.linked + kinds.ipc.linked;
    return {
      sub_project: nameOf(held.project),
      detected,
      linked,
      unlinked_count: Math.max(0, detected - linked),
      by_kind: kinds,
      unlinked: (held.unlinked ?? []).slice(0, UNLINKED_SAMPLE),
    };
  });
}
