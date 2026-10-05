import type { BreakingChange, CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isContainer, refOfNode, viewOf, type GraphView } from './analysis-graph-view';
import type { RenameMatch } from './analysis-rename-match';

type Verdict = NonNullable<BreakingChange['verdict']>;

const NAMED_ARGUMENT_LANGUAGES = new Set(['python', 'ruby', 'kotlin', 'swift', 'csharp', 'scala', 'dart', 'r', 'julia']);
const CONSUMER_LIMIT = 25;
const ACCESS_RANK: Record<string, number> = { public: 0, protected: 1, private: 2 };
const SEVERITY: Record<Verdict, number> = { breaking: 2, 'potentially-breaking': 1, 'non-breaking': 0 };

type Parameter = NonNullable<NonNullable<CASNode['signature']>['parameters']>[number];

function exported(node: CASNode): boolean {
  return node.metadata?.is_exported === true;
}

function access(node: CASNode): number {
  return ACCESS_RANK[node.metadata?.access_modifier ?? 'public'] ?? 0;
}

function text(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, '');
}

function renderSignature(node: CASNode): string {
  const signature = node.signature;
  const parameters = (signature?.parameters ?? [])
    .map(parameter => `${parameter.name}${parameter.optional ? '?' : ''}${parameter.type === undefined ? '' : `: ${parameter.type}`}`)
    .join(', ');
  return `${node.name}(${parameters})${signature?.return_type === undefined ? '' : `: ${signature.return_type}`}`;
}

function worse(left: Verdict, right: Verdict): Verdict {
  return SEVERITY[right] > SEVERITY[left] ? right : left;
}

function isOptional(parameter: Parameter): boolean {
  return parameter.optional === true || parameter.default_value !== undefined;
}

function compareSignatures(old: CASNode, now: CASNode): { verdict: Verdict; reasons: string[] } | undefined {
  if (old.signature === undefined || now.signature === undefined) return undefined;
  const before = old.signature.parameters ?? [];
  const after = now.signature.parameters ?? [];
  const reasons: string[] = [];
  let verdict: Verdict = 'non-breaking';
  const note = (level: Verdict, reason: string) => {
    verdict = worse(verdict, level);
    reasons.push(reason);
  };
  if (after.length < before.length) note('breaking', `${before.length - after.length} parameter(s) removed`);
  for (let at = 0; at < Math.min(before.length, after.length); at++) {
    const left = before[at];
    const right = after[at];
    const leftType = text(left.type);
    const rightType = text(right.type);
    if (leftType !== undefined && rightType !== undefined && leftType !== rightType) {
      note('breaking', `parameter ${at + 1} type ${left.type} -> ${right.type}`);
    } else if ((leftType === undefined) !== (rightType === undefined)) {
      note('potentially-breaking', `parameter ${at + 1} type ${leftType === undefined ? 'added' : 'removed'}`);
    }
    if (!isOptional(left) && isOptional(right)) reasons.push(`parameter ${at + 1} became optional`);
    if (isOptional(left) && !isOptional(right)) note('breaking', `parameter ${at + 1} became required`);
    if (left.name !== right.name) {
      const named = NAMED_ARGUMENT_LANGUAGES.has(now.metadata?.language ?? '');
      note(named ? 'potentially-breaking' : 'non-breaking', `parameter ${at + 1} renamed ${left.name} -> ${right.name}`);
    }
  }
  for (const added of after.slice(before.length)) {
    if (isOptional(added)) reasons.push(`optional parameter ${added.name} added`);
    else note('breaking', `required parameter ${added.name} added`);
  }
  const leftReturn = text(old.signature.return_type);
  const rightReturn = text(now.signature.return_type);
  if (leftReturn !== undefined && rightReturn !== undefined && leftReturn !== rightReturn) {
    note('breaking', `return type ${old.signature.return_type} -> ${now.signature.return_type}`);
  } else if ((leftReturn === undefined) !== (rightReturn === undefined)) {
    note('potentially-breaking', `return type ${leftReturn === undefined ? 'added' : 'removed'}`);
  }
  return reasons.length === 0 ? undefined : { verdict, reasons };
}

function consumersOf(callersIn: GraphView, id: string, stillThere: (caller: string) => CASNode | undefined) {
  const held = callersIn.callers(id).flatMap(caller => {
    const node = stillThere(caller);
    return node === undefined ? [] : [node];
  });
  const listed = held.slice(0, CONSUMER_LIMIT);
  return { ids: listed.map(node => node.id), named: listed.map(node => refOfNode(node, node.id)), total: held.length };
}

function entry(
  type: BreakingChange['type'],
  verdict: Verdict,
  node: CASNode,
  description: string,
  consumers: ReturnType<typeof consumersOf>,
  suggestedMigration?: string,
): BreakingChange {
  return {
    type,
    verdict,
    nodeId: node.id,
    description: consumers.total > consumers.ids.length ? `${description} (${consumers.total} consumers, ${consumers.ids.length} listed)` : description,
    affectedConsumers: consumers.ids,
    consumers: consumers.named.map(held => ({ id: held.id, name: held.name, file: held.file, line: held.line })),
    ...(suggestedMigration === undefined ? {} : { suggestedMigration }),
  };
}

export function breakingChangesBetween(baseline: CASOutput, proposed: CASOutput, renames: RenameMatch): BreakingChange[] {
  const before = viewOf(baseline);
  const after = viewOf(proposed);
  const found: BreakingChange[] = [];
  const carried = (caller: string) => after.node(renames.idMap.get(caller) ?? caller);
  const here = (caller: string) => after.node(caller);
  for (const old of before.declarations.filter(exported)) {
    const renamedTo = renames.idMap.get(old.id);
    const now = renamedTo === undefined ? after.node(old.id) : after.node(renamedTo);
    if (now === undefined) {
      const consumers = consumersOf(before, old.id, carried);
      const known = consumers.total > 0;
      found.push(entry(
        'removed-export',
        known ? 'breaking' : 'potentially-breaking',
        old,
        `exported ${old.type} ${renderSignature(old)} was removed${known ? '' : '; no consumer is known inside this analysis, external consumers cannot be ruled out'}`,
        consumers,
        'Restore it or move each consumer to its replacement',
      ));
      continue;
    }
    if (renamedTo !== undefined) {
      const consumers = consumersOf(before, old.id, carried);
      const migrated = before.callers(old.id).every(caller => after.callees(renames.idMap.get(caller) ?? caller).includes(now.id));
      const level: Verdict = consumers.total > 0 && !migrated ? 'breaking' : 'potentially-breaking';
      found.push(entry(
        'renamed-export',
        level,
        old,
        `exported ${old.type} ${old.name} is now ${now.name}; ${consumers.total === 0 ? 'no consumer is known inside this analysis' : migrated ? 'every known consumer calls the new name' : 'some known consumers still use the old name'}; consumers outside this analysis still use the old name`,
        consumers,
        `Call ${now.name} instead of ${old.name}`,
      ));
      const signature = compareSignatures(old, now);
      if (signature !== undefined) {
        found.push(entry('signature-change', signature.verdict, now, `${renderSignature(old)} -> ${renderSignature(now)}: ${signature.reasons.join('; ')}`, consumersOf(after, now.id, here)));
      }
      continue;
    }
    if (exported(old) && !exported(now)) {
      found.push(entry('visibility-change', 'breaking', now, `${old.type} ${now.name} is no longer exported`, consumersOf(after, now.id, here), 'Export it again or move consumers to a public entry'));
      continue;
    }
    if (access(now) > access(old)) {
      found.push(entry('visibility-change', 'breaking', now, `${old.type} ${now.name} access narrowed from ${old.metadata?.access_modifier ?? 'public'} to ${now.metadata?.access_modifier ?? 'public'}`, consumersOf(after, now.id, here)));
    }
    const signature = compareSignatures(old, now);
    if (signature !== undefined) {
      found.push(entry('signature-change', signature.verdict, now, `${renderSignature(old)} -> ${renderSignature(now)}: ${signature.reasons.join('; ')}`, consumersOf(after, now.id, here)));
    }
    if (isContainer(old)) {
      const kept = new Set(after.members(now.id).map(member => `${member.type}:${member.name}`));
      const lost = before.members(old.id).filter(member => !kept.has(`${member.type}:${member.name}`) && !exported(member));
      if (lost.length > 0) {
        found.push(entry('type-change', 'breaking', now, `exported ${old.type} ${now.name} lost member(s): ${lost.map(member => member.name).join(', ')}`, consumersOf(after, now.id, here)));
      }
    }
  }
  return found.sort((left, right) => SEVERITY[right.verdict ?? 'non-breaking'] - SEVERITY[left.verdict ?? 'non-breaking'] || left.nodeId.localeCompare(right.nodeId));
}
