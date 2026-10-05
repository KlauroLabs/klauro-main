export interface CASCausalJourneyStep {
  file: string;
  symbol: string;
  does: string;
  via?: 'ipc' | 'event' | 'network' | 'process' | 'queue';
  effect?: string;
}

export interface CASCausalJourney {
  id: string;
  label: string;
  does: string;
  rank: number;
  representative: boolean;
  steps: CASCausalJourneyStep[];
}
