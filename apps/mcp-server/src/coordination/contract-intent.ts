
























import type { SymbolChange } from './conceptual-conflict';
import type { ContractKind, DeclaredContract, DerivedPhase } from './types';








export const MAX_CONTRACTS_PER_CLAIM = 64;

export const MAX_CONSUMES_PER_CLAIM = 64;

export const MAX_CONTRACT_TEXT = 512;

const TRUNCATION_MARKER = '…[truncated]';


export function capContractText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= MAX_CONTRACT_TEXT) return text;
  return text.slice(0, MAX_CONTRACT_TEXT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}





function normalizePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}






export function contractIdentity(c: Pick<DeclaredContract, 'kind' | 'name' | 'path'>): string {
  return `${c.kind}::${c.name}::${normalizePath(c.path) ?? ''}`;
}









export type ContractMatchConfidence = 'path_qualified' | 'name_only';

export interface ContractMatch {
  contract: DeclaredContract;
  confidence: ContractMatchConfidence;

  ambiguous: boolean;
}







export function matchContract(
  ref: { name: string; path?: string; kind?: ContractKind },
  pool: DeclaredContract[]
): ContractMatch[] {
  const byName = pool.filter((c) => c.name === ref.name && (!ref.kind || c.kind === ref.kind));
  if (byName.length === 0) return [];
  const refPath = normalizePath(ref.path);
  if (refPath) {
    const exact = byName.filter((c) => normalizePath(c.path) === refPath);
    if (exact.length > 0) {
      return exact.map((c) => ({ contract: c, confidence: 'path_qualified' as const, ambiguous: exact.length > 1 }));
    }
  }
  return byName.map((c) => ({ contract: c, confidence: 'name_only' as const, ambiguous: byName.length > 1 }));
}









export function mergeContracts(
  declared: DeclaredContract[] = [],
  observed: DeclaredContract[] = []
): DeclaredContract[] {
  const out = new Map<string, DeclaredContract>();
  for (const c of declared) {
    out.set(contractIdentity(c), {
      ...c,
      signature: capContractText(c.signature),
      notes: capContractText(c.notes),
      status: c.status ?? 'declared',
    });
  }
  for (const c of observed) {
    const id = contractIdentity(c);
    const prior = out.get(id);
    if (!prior) {
      out.set(id, { ...c, signature: capContractText(c.signature), notes: capContractText(c.notes), status: 'observed' });
      continue;
    }
    if (prior.status === 'declared' || prior.status === undefined) {

      if (!prior.signature && c.signature) prior.signature = capContractText(c.signature);
      continue;
    }
    out.set(id, { ...prior, ...c, signature: capContractText(c.signature ?? prior.signature), status: 'observed' });
  }
  return [...out.values()].slice(0, MAX_CONTRACTS_PER_CLAIM);
}











const SURFACE_CHANGE_KINDS = new Set<SymbolChange['change_kind']>([
  'signature',
  'return_type',
  'nullability',
  'param',
  'rename',
  'split',
  'move',
  'delete',
  'add',
]);


const UNPARSED_FILE_SENTINEL = '__file__';

function isSurfaceChange(change: SymbolChange): boolean {
  if (!SURFACE_CHANGE_KINDS.has(change.change_kind)) return false;


  if (change.symbol_id.endsWith(`:${UNPARSED_FILE_SENTINEL}`)) return false;
  return !!change.name;
}

function contractKindForChange(change: SymbolChange): ContractKind {
  if (change.change_kind === 'add' || change.change_kind === 'delete' || change.change_kind === 'move') {
    return 'export';
  }
  return 'signature';
}













export function deriveObservedProduces(changes: SymbolChange[]): DeclaredContract[] {
  const out = new Map<string, DeclaredContract>();
  for (const change of changes) {
    if (!isSurfaceChange(change)) continue;
    const contract: DeclaredContract = {
      kind: contractKindForChange(change),
      name: change.name,
      path: normalizePath(change.file),
      signature: capContractText(change.after?.signature ?? change.before?.signature),
      status: 'observed',
    };
    const id = contractIdentity(contract);
    if (!out.has(id)) out.set(id, contract);
    if (out.size >= MAX_CONTRACTS_PER_CLAIM) break;
  }
  return [...out.values()];
}






export interface PeerContracts {
  agent_id: string;
  claim_id: string;
  contracts: DeclaredContract[];
}

export interface ObservedConsumesResult {

  names: string[];

  edges: Array<{
    name: string;
    producer_agent_id: string;
    producer_claim_id: string;
    confidence: ContractMatchConfidence;
    ambiguous: boolean;
    evidence: string;
  }>;
}








function referenceHaystack(change: SymbolChange, addedTextByFile: Map<string, string>): string {
  return [
    change.after?.signature,
    change.after?.return_type,
    change.before?.signature,
    change.before?.return_type,
    addedTextByFile.get(normalizePath(change.file) ?? change.file),
  ]
    .filter(Boolean)
    .join('\n');
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}






function referencesContract(haystack: string, contract: DeclaredContract): boolean {
  const needle =
    contract.kind === 'endpoint' && /\s/.test(contract.name)
      ? contract.name.slice(contract.name.indexOf(' ') + 1).trim()
      : contract.name;
  if (!needle) return false;


  const pattern = new RegExp(`(^|[^A-Za-z0-9_$/])${escapeForRegex(needle)}([^A-Za-z0-9_$]|$)`);
  return pattern.test(haystack);
}











export function deriveObservedConsumes(
  input: { changes: SymbolChange[]; addedTextByFile?: Record<string, string> },
  peers: PeerContracts[],
  ownContracts: DeclaredContract[] = []
): ObservedConsumesResult {
  const addedText = new Map(Object.entries(input.addedTextByFile ?? {}).map(([k, v]) => [normalizePath(k) ?? k, v]));
  const ownIds = new Set(ownContracts.map((c) => contractIdentity(c)));
  const ownNames = new Set(ownContracts.map((c) => c.name));
  const names = new Set<string>();
  const edges: ObservedConsumesResult['edges'] = [];
  const seenEdges = new Set<string>();

  for (const change of input.changes) {
    const haystack = referenceHaystack(change, addedText);
    if (!haystack) continue;
    for (const peer of peers) {
      for (const contract of peer.contracts) {
        if (ownIds.has(contractIdentity(contract)) || ownNames.has(contract.name)) continue;
        if (!referencesContract(haystack, contract)) continue;



        const edgeKey = `${peer.claim_id}::${contractIdentity(contract)}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        const sameFileDecl = normalizePath(contract.path) && normalizePath(contract.path) === normalizePath(change.file);
        const nameMatches = peers.flatMap((p) => p.contracts).filter((c) => c.name === contract.name);
        edges.push({
          name: contract.name,
          producer_agent_id: peer.agent_id,
          producer_claim_id: peer.claim_id,
          confidence: sameFileDecl ? 'path_qualified' : 'name_only',
          ambiguous: nameMatches.length > 1,
          evidence: `${change.symbol_id} references ${contract.kind}:${contract.name}`,
        });
        names.add(contract.name);
        if (names.size >= MAX_CONSUMES_PER_CLAIM) break;
      }
    }
  }
  return { names: [...names].slice(0, MAX_CONSUMES_PER_CLAIM), edges };
}















export function attributeChangesToClaim(
  changes: SymbolChange[],
  myClaim: { scope: { paths: string[]; symbols: string[] } },
  otherActiveClaims: Array<{ scope: { paths: string[]; symbols: string[] } }>
): { mine: SymbolChange[]; shared: SymbolChange[] } {
  const covers = (claim: { scope: { paths: string[]; symbols: string[] } }, change: SymbolChange): boolean => {
    if (claim.scope.symbols?.includes(change.symbol_id) || claim.scope.symbols?.includes(change.name)) return true;
    const file = normalizePath(change.file);
    if (!file) return false;
    return (claim.scope.paths ?? []).some((p) => {
      const np = normalizePath(p);
      return !!np && (file === np || file.startsWith(`${np}/`));
    });
  };
  const mine: SymbolChange[] = [];
  const shared: SymbolChange[] = [];
  for (const change of changes) {
    if (!covers(myClaim, change)) continue;
    if (otherActiveClaims.some((c) => covers(c, change))) shared.push(change);
    else mine.push(change);
  }
  return { mine, shared };
}









export function isAttributionSound(input: { participantsInTree: number }): boolean {
  return input.participantsInTree <= 1;
}





const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|Test\.(java|kt|cs|swift)$/;







export function derivePhase(input: { changes?: SymbolChange[] }): DerivedPhase {
  const changes = input.changes ?? [];
  if (changes.length === 0) return 'exploring';
  if (changes.some((c) => TEST_FILE_PATTERN.test(c.file ?? ''))) return 'verifying';
  return 'building';
}








export function derivePhaseFromClaim(claim: { produces?: DeclaredContract[] }): DerivedPhase {
  const observed = (claim.produces ?? []).filter((c) => c.status === 'observed');
  if (observed.length === 0) return 'exploring';
  if (observed.some((c) => TEST_FILE_PATTERN.test(c.path ?? ''))) return 'verifying';
  return 'building';
}












export function isExplorationClaim(claim: {
  scope: { paths: string[]; symbols: string[] };
  produces?: DeclaredContract[];
}): boolean {
  return (
    (claim.scope.paths?.length ?? 0) === 0 &&
    (claim.scope.symbols?.length ?? 0) === 0 &&
    (claim.produces?.length ?? 0) === 0
  );
}


export const EXPLORATION_CLAIM_NOTE =
  'This claim has NO paths/symbols yet — it is visible to the fleet as an exploration claim ' +
  '(phase: exploring), but it cannot participate in overlap detection or event drain until it ' +
  'has a footprint. Call fab_extend with add_paths/add_symbols (and declare `produces`) the ' +
  'moment you localize your work.';
