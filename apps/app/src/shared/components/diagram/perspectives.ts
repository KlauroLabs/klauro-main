export interface DiagramPerspective {
  id: string;
  label: string;

  description: string;
}

export const STRUCTURAL_PERSPECTIVE: DiagramPerspective = {
  id: 'structural',
  label: 'Structural',
  description: 'Default view — nodes as the system is composed, edges as the relationships that were detected.',
};

export const ARCHITECTURE_CONCEPTS_PERSPECTIVE: DiagramPerspective = {
  id: 'concepts',
  label: 'Concepts',
  description: 'Default view — grouped by framework concept (Services, Controllers, Repositories…); edges are aggregated call-graph relationships between groups where cheaply derivable.',
};

export const ARCHITECTURE_DEPLOYABLES_PERSPECTIVE: DiagramPerspective = {
  id: 'deployables',
  label: 'Deployables',
  description: 'Grouped by real ship/runnable artifact (deployable_evidence); edges are bundled-into relationships.',
};
