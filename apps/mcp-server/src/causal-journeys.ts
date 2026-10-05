import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CASCausalJourney } from '../../../packages/analyzer-core/src/types/causal-journey.types';

export interface CausalJourneyQuery {
  journeyId?: string;
  kind?: string;
  limit?: number;
  offset?: number;
  format?: 'json' | 'markdown';
  includeSteps?: boolean;
}

const DEFAULT_LIMIT = 25;

export function hasCausalJourneys(cas: CASOutput): boolean {
  return cas.causal_journeys !== undefined;
}

export function scopeCausalJourneys(
  journeys: CASCausalJourney[] | undefined,
  reachableFiles: ReadonlySet<string>,
): CASCausalJourney[] | undefined {
  const held = (journeys ?? []).filter(journey => journey.steps.some(step => reachableFiles.has(step.file)));
  return held.length > 0 ? held : undefined;
}

function stepLine(step: CASCausalJourney['steps'][number], position: number): string {
  const crossing = step.via ? ` [${step.via}]` : '';
  return `${position + 1}. ${step.does}${crossing} (${step.symbol} in ${step.file})`;
}

function journeyMarkdown(journey: CASCausalJourney): string {
  return [
    `### ${journey.label}${journey.representative ? ' (representative)' : ''}`,
    journey.does,
    '',
    ...journey.steps.map(stepLine),
  ].join('\n');
}

export function getCausalJourneys(cas: CASOutput, query: CausalJourneyQuery = {}) {
  const all = [...(cas.causal_journeys ?? [])].sort((left, right) => left.rank - right.rank);
  if (query.journeyId) {
    const journey = all.find(item => item.id === query.journeyId) ?? null;
    if (query.format === 'markdown') {
      return { markdown: journey ? journeyMarkdown(journey) : `No journey with id '${query.journeyId}'.` };
    }
    return { journey };
  }
  const filtered = query.kind === 'representative' ? all.filter(journey => journey.representative) : all;
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const page = filtered.slice(offset, offset + limit);
  if (query.format === 'markdown') {
    const heading = `${filtered.length} causal journeys (showing ${page.length} from ${offset})`;
    return { markdown: [heading, '', ...page.map(journeyMarkdown)].join('\n\n') };
  }
  return {
    total: filtered.length,
    offset,
    limit,
    representative: all.filter(journey => journey.representative).length,
    journeys: page.map(journey => (query.includeSteps === false ? { ...journey, steps: undefined, step_count: journey.steps.length } : journey)),
  };
}
