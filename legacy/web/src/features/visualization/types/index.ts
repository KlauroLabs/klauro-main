export * from '../../../types/cas.types';

export interface FilterState {
  types: string[];
  levels: number[];
  perspectives: string[];
  showOrphaned: boolean;
  showCritical: boolean;
  showEntryPoints: boolean;
  searchQuery: string;
}

export interface ViewState {
  currentView: VisualizationView;
  selectedNodeId: string | null;
  selectedChainId: string | null;
  zoom: number;
  pan: { x: number; y: number };
}

export type VisualizationView =
  | 'overview'
  | 'entry-points'
  | 'exit-points'
  | 'call-chains'
  | 'external-services'
  | 'patterns'
  | 'component-detail';

export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  positions: Map<string, NodePosition>;
  bounds: { width: number; height: number };
}

export interface ConnectionBundle {
  type: string;
  label: string;
  color: string;
  nodes: Array<{
    node: import('../../../types/cas.types').CASNode;
    count: number;
  }>;
}

export interface ViewNavigationItem {
  id: VisualizationView;
  label: string;
  icon: string;
  count?: number;
  badge?: 'warning' | 'error' | 'info';
}

export const DEFAULT_FILTER_STATE: FilterState = {
  types: [],
  levels: [],
  perspectives: [],
  showOrphaned: false,
  showCritical: false,
  showEntryPoints: false,
  searchQuery: '',
};

export const DEFAULT_VIEW_STATE: ViewState = {
  currentView: 'overview',
  selectedNodeId: null,
  selectedChainId: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
};
