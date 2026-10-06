export interface JourneyStep {
  flow_id: string;
  name: string;
  unit?: string;
  file?: string;
  via?: string;
}

export interface JourneyFlow {
  flow_id: string;
  name: string;
  entry_point: string;
  via?: string;
  channel?: string;
  steps: number;
  effect?: string;
  capabilities: string[];
}

export interface JourneyView {
  id: string;
  label: string;
  does: string;
  rank: number;
  programs: number;
  flows: JourneyFlow[];
  steps: JourneyStep[];
  effect?: string;
  unshipped?: boolean;
}

export interface JourneyBounds {
  max_flows_per_journey: number;
  max_branches_per_flow: number;
  max_journeys_enumerated: number;
  links_not_followed: number;
}

export interface JourneyProjection {
  total: number;
  journeys: JourneyView[];
  bounds: JourneyBounds;
}
