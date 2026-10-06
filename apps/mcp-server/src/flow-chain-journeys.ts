import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { JourneyView } from '../../../packages/analyzer-core/src/types/journey-view.types';
import { projectJourneys } from '../../../packages/analyzer-core/src/analyzer/core/flow-chains';

export interface JourneyQuery {
  journeyId?: string;
  limit?: number;
  offset?: number;
  format?: 'json' | 'markdown';
  includeSteps?: boolean;
}

const DEFAULT_LIMIT = 25;
const MOST_STEPS_LISTED_PER_FLOW = 12;

function flowLines(journey: JourneyView): string[] {
  return journey.flows.flatMap(flow => {
    const own = journey.steps.filter(step => step.flow_id === flow.flow_id);
    const crossing = flow.via ? ` [${flow.via}${flow.channel ? ` ${flow.channel}` : ''}]` : '';
    const listed = own.slice(0, MOST_STEPS_LISTED_PER_FLOW).map((step, at) => `   ${at + 1}. ${step.name}${step.file ? ` (${step.file})` : ''}`);
    const hidden = own.length - listed.length;
    return [`- ${flow.name}${crossing}: ${own.length} steps`, ...listed, ...(hidden > 0 ? [`   (${hidden} more steps; ${own.length} in total)`] : [])];
  });
}

function journeyMarkdown(journey: JourneyView): string {
  return [`### ${journey.label}`, journey.does, '', ...flowLines(journey)].join('\n');
}

export function getFlowChainJourneys(cas: CASOutput, query: JourneyQuery = {}) {
  const { total, journeys, bounds } = projectJourneys(cas);
  if (query.journeyId) {
    const journey = journeys.find(item => item.id === query.journeyId) ?? null;
    if (query.format === 'markdown') {
      return { markdown: journey ? journeyMarkdown(journey) : `No journey with id '${query.journeyId}'.` };
    }
    return { journey };
  }
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;
  const page = journeys.slice(offset, offset + limit);
  if (query.format === 'markdown') {
    const heading = `${total} journeys chained from flows (showing ${page.length} from ${offset}; up to ${bounds.max_flows_per_journey} flows each, ${bounds.links_not_followed} links beyond the bounds not followed)`;
    return { markdown: [heading, '', ...page.map(journeyMarkdown)].join('\n\n') };
  }
  return {
    total,
    offset,
    limit,
    shown: page.length,
    bounds,
    journeys: page.map(journey => (query.includeSteps === false ? { ...journey, steps: undefined, step_count: journey.steps.length } : journey)),
  };
}
