import type { CASOutput } from '../../types/cas.types';
import type { TierStackIndex } from './read-tier-stack';

type NodeContract = NonNullable<CASOutput['nodes'][number]['contract']>;

interface TierStackIcelot {
  unit: string;
  input?: { types?: string[]; reads?: string[] };
  constraints?: { throws?: string[] };
  effects?: { writes?: string[]; exits?: string[] };
  logic?: { branches?: number; loops?: number; awaits?: number; calls?: number };
  output?: { return_type?: string };
}

function logicOf(logic: NonNullable<TierStackIcelot['logic']>): string {
  const counted = [
    ['calls', logic.calls],
    ['branches', logic.branches],
    ['loops', logic.loops],
    ['awaits', logic.awaits],
  ].filter((pair): pair is [string, number] => typeof pair[1] === 'number' && pair[1] > 0);
  return counted.map(([name, count]) => `${count} ${name}`).join(', ');
}

const KEPT_IN_PLACE = new Set(['database', 'cache', 'file', 'client_storage']);

export function nodeContractsOf(index: TierStackIndex): Map<string, NodeContract> {
  const held = new Map<string, NodeContract>();
  const exits = new Map((index.exit_points ?? []).map(exit => [exit.id, exit] as const));
  const units = Array.isArray(index.icelot) ? (index.icelot as TierStackIcelot[]) : [];
  for (const unit of units) {
    held.set(unit.unit, {
      input: [...(unit.input?.types ?? []), ...(unit.input?.reads ?? [])],
      logic: logicOf(unit.logic ?? {}),
      side_effects: {
        state_changes: unit.effects?.writes ?? [],
        external_integrations: [...new Set((unit.effects?.exits ?? [])
          .map(id => exits.get(id))
          .filter(exit => exit !== undefined && !KEPT_IN_PLACE.has(exit.kind))
          .map(exit => exit!.service ?? exit!.target))],
      },
      output: unit.output?.return_type === undefined ? [] : [unit.output.return_type],
      constraints: (unit.constraints?.throws ?? []).map(thrown => ({
        kind: 'error' as const,
        rule: `throws ${thrown}`,
        evidence: unit.unit,
      })),
    });
  }
  return held;
}
