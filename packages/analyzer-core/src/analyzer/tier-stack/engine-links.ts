import { execFileSync } from 'child_process';
import { enginePath } from './read-tier-stack';

export interface EngineLinkRoute {
  id: string;
  node: string;
  method?: string;
  path: string;
  file?: string;
  line?: number;
}

export interface EngineLinkCall {
  id: string;
  node: string;
  method?: string;
  path: string;
  origin?: string;
}

export interface EngineLinkRepository {
  name: string;
  path: string;
  hosts: string[];
  provides: EngineLinkRoute[];
  calls: EngineLinkCall[];
}

export interface EngineLinkParty {
  name: string;
  path: string;
}

export interface EngineApiLink {
  consumer: EngineLinkParty;
  provider: EngineLinkParty;
  call: string;
  call_node: string;
  route: string;
  route_node: string;
  endpoint: string;
  method?: string;
  call_method?: string;
  confidence: number;
  basis: string;
  file?: string;
  line?: number;
}

export interface EngineApiAmbiguity {
  consumer: EngineLinkParty;
  call: string;
  call_node: string;
  endpoint: string;
  method?: string;
  reason: string;
  candidates: Array<{ provider: EngineLinkParty; route: string }>;
}

export interface EngineLinked {
  links: EngineApiLink[];
  ambiguous: EngineApiAmbiguity[];
}

export function linkRepositories(repositories: EngineLinkRepository[]): EngineLinked {
  const relevant = repositories.filter(repository => repository.provides.length > 0 || repository.calls.length > 0);
  if (relevant.length < 2) return { links: [], ambiguous: [] };
  const out = execFileSync(enginePath(), ['--link'], {
    input: JSON.stringify({ repositories: relevant }),
    maxBuffer: 1 << 28,
    encoding: 'utf8',
  });
  return JSON.parse(out) as EngineLinked;
}
